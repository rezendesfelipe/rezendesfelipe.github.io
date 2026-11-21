---
title: "Pipeline parameters: provision only what you choose (Terraform, one tfstate per stack and GitOps)"
description: "How to use parameters in Azure DevOps and GitHub Actions to choose which Terraform stacks run, with one tfstate per stack and Argo CD, on a private AKS architecture."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modules", "aks", "argocd", "gitops", "postgresql", "private-link", "platform-engineering", "azure"]
readingTime: "25 min"
lang: "en"
draft: true
---

> **TL;DR**
> - Split infrastructure into independent *stacks*, each with its own `tfstate` and built on modules. Make the pipeline take parameters that say **what to run**, **where** and **with which action**.
> - The gain: smaller blast radius, least privilege per stack, faster `plan` and a single pipeline to maintain.
> - The example is a real architecture: AKS and PostgreSQL in a private network. Terraform delivers the network, the cluster and the application's dedicated database. The application enters the cluster through **Argo CD**, from manifests in `infra/argocd`.
> - The same design works in Azure DevOps (`parameters`) and GitHub Actions (`workflow_dispatch`).
> - The cost: more moving parts, and dependencies between stacks that become your responsibility.

---

## The problem that got me here

Every infrastructure team goes through a similar phase. It starts with one Terraform repo, one `main.tf` and a pipeline that runs `terraform apply`. It works until the file grows: network, database, cluster, Key Vault, monitoring, all in the same state.

Then the symptoms show up, and I've lived all of them:

- You only wanted to create a subnet, but the `plan` takes 12 minutes because it refreshes 600 resources.
- An unexpected cluster diff shows up in the plan of a change that was only about networking.
- Two people work on different parts and one waits for the other's lock.
- The pipeline's service principal can do everything, because the state is one.
- A human mistake in one `apply` hits the database along with everything else.

What I use today has two halves that go together:

1. **Design:** infrastructure is split into independent *stacks*, each with its own `tfstate`, built on reusable **modules**.
2. **Execution:** the pipeline receives **parameters** that say *which* stacks to run, in *which* environment, with *which* action.

One half without the other doesn't solve it. Parameters without split state become a checkbox that changes nothing. Split state without parameters becomes a pile of duplicated pipelines.

> **How to read this article.** Every link points to official documentation or published research. When an idea is mine, and not the source's, I mark it as **my reading**. The code is simplified to explain the design: adapt names, versions and permissions to your environment and try it in dev before anything else. If you want to see the parameters working, jump to [Pipeline parameters](#pipeline-parameters). The full stack and module code is in the [Appendix](#appendix-stack-and-module-code).

---

## The idea in one picture

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="A parameter panel (environment, instance, action and one checkbox per step) feeds a single pipeline that runs only the ticked steps: the vnet-core-prod-brs-01 and aks-core-prod-brs-01 stacks. The orders application stack and the Argo CD bootstrap are unticked and do not run. Each stack writes to its own tfstate, named after the resource, in the same Azure Storage container." loading="lazy" />
    <figcaption>Figure 1 — Parameters choose what runs. Each stack has its own tfstate, so whatever wasn't selected is neither read nor changed.</figcaption>
</figure>

There is one pipeline, and what changes from run to run are the parameters. Since each stack has its own state, "not running" a stack is safe: it simply doesn't take part.

---

## Why this matters

### 1. Smaller blast radius

HashiCorp says, in its [workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices), that any operation on a resource can affect other resources in the same state, and that you should keep the blast radius small: group by volatility (what changes often stays away from what rarely changes), separate stateful from stateless (databases away from compute) and split by responsibility and privileges. The same page warns that slow plans and applies are an early sign of a bloated scope, and the [state refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) reinforces that resources with different cadences should be managed separately.

In practice: a bad `apply` on the cluster stack doesn't put networking or the database in the line of fire.

### 2. Least privilege

Each stack can run with a different identity holding only the permissions it needs: networking needs `Network Contributor` at its scope, the application stack needs another set, and the pipeline with `Owner` on the subscription is no longer necessary. HashiCorp recommends splitting workspaces by responsibility and privileges for exactly this reason. The same logic appears in the [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy), which separate the platform from the workloads (the link to Terraform stacks is **my reading**).

### 3. Faster feedback

Smaller `plan`, smaller `apply`, smaller lock. The `azurerm` backend uses native Blob Storage features for locking ([backend docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) and [Microsoft's docs](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)). Since each stack is a blob with its own `key`, nobody waits for anybody.

### 4. Small, frequent changes

The Azure Well-Architected Framework, in [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recommends small, incremental releases with quality gates, and standardized, automated deployments to reduce human error. Selecting only what changed is the infrastructure version of that idea.

DORA measures [five delivery metrics](https://dora.dev/guides/dora-metrics/) and states that speed and stability are not tradeoffs. That smaller, more isolated changes help those metrics is **my reading**, backed by what the [2024 report](https://dora.dev/research/2024/dora-report/) reinforces: small batch sizes and robust testing remain crucial.

### 5. One pipeline to maintain, not ten

Instead of `pipeline-vnet.yml`, `pipeline-aks.yml` and `pipeline-app.yml` with 90% identical code, there is one stack template and one orchestrator: fix authentication once, it's fixed everywhere. DORA's [Deployment automation](https://dora.dev/capabilities/deployment-automation/) capability describes this shape, and the [Twelve-Factor App](https://12factor.net/config) gives the criterion: config is what changes between deploys and stays out of code, and the internal "wiring" belongs in code. Here, environment and instance are config. The module calls inside each stack are code.

---

## The reference architecture

To keep the example from being abstract, I picked an architecture I run into often: an application on **AKS** with a **PostgreSQL** dedicated to it, everything in a private network. The icons are the official Microsoft ones ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), used according to the terms: no change to their shape and with the product name next to the icon).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Reference architecture in a private network: corporate network users enter through an internal ingress into the aks-core-prod-brs-01 cluster, inside the snet-aks subnet, where the orders pod runs. The pod reaches the dedicated PostgreSQL pgsql-orders-prod-brs-01, in the delegated snet-postgres subnet, and, through Private Endpoints in snet-endpoints, the Key Vault. The cluster pulls images from the Container Registry through another Private Endpoint. Argo CD, inside the cluster, syncs the manifests from a Git repository to the pod. Self-hosted agents in snet-agents run Terraform and the Argo CD bootstrap. Private DNS zones linked to the VNet resolve the names. Each resource is tagged with the Terraform stack that owns it: vnet-core-prod-brs-01, aks-core-prod-brs-01 or app-orders-prod-brs-01." loading="lazy" />
    <figcaption>Figure 2 — Reference architecture. The pills show the Terraform stack that owns each resource. The pod enters the cluster through Argo CD, from Git, outside Terraform. The editable source is in draw.io.</figcaption>
</figure>

What the figure shows, and the documentation behind each decision:

- **AKS as a private cluster.** With `private_cluster_enabled`, the API server gets an internal IP and talks to the nodes through Azure Private Link ([docs](https://learn.microsoft.com/en-us/azure/aks/private-clusters)).
- **PostgreSQL with network integration (private access).** The server sits in a **delegated** subnet reserved for it, at least `/28`, and needs a Private DNS zone ending in `postgres.database.azure.com`. Through Terraform, you create those zones, and the zone name can't be the same as the server's ([docs](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)).
- **ACR and Key Vault through Private Endpoints.** ACR private link requires the **Premium** SKU ([docs](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). Key Vault uses the same mechanism ([docs](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)). DNS zones and subresources (`registry`, `vault`) are in the [zone table](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Self-hosted agents in the VNet.** The pipeline has to reach the cluster API (at the Argo CD bootstrap) and, if you close public access, the registry and the state account. The ACR docs warn that without public access Azure DevOps Services can't reach it, and the [private cluster access](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) docs say `az aks command invoke` is not for programmatic access. The agents live outside this example's stacks (`snet-agents` is dashed).
- **Argo CD inside the cluster, pulling from Git.** [Argo CD](https://argo-cd.readthedocs.io/en/stable/) is a Kubernetes controller that continuously compares the live state with the desired state, defined in Git. Since it fetches changes from Git, the pipeline only needs to reach the private API at the bootstrap (**my reading** of the model the docs describe). The price is in the figure: the cluster has to reach the Git repository.
- **Out of scope, on purpose:** the cluster's egress design, a separate decision with a firewall or NAT (the provider accepts `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` and `none` in `outbound_type`).

### Naming pattern

I name everything `<type>-<name>-<environment>-<region>-<seq>`. The **name** says what the resource is or whom it serves: `core` for the shared platform, `orders` for the application. Some examples:

| Resource | Name |
|---|---|
| Platform VNet | `vnet-core-prod-brs-01` |
| AKS cluster | `aks-core-prod-brs-01` |
| Orders application database | `pgsql-orders-prod-brs-01` |
| Orders application Key Vault | `kv-orders-prod-brs-01` |
| Any other resource, even a VM | `vm-orders-prod-brs-01` |

The type follows the [Cloud Adoption Framework abbreviations](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations) (`vnet`, `snet`, `aks`, `kv`, `rg`, `pep` for private endpoint, `pgsql` for PostgreSQL flexible server, `cr` for container registry, `id` for managed identity), and the component order is the one Microsoft documents in [define your naming convention](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming). `brs` is my pattern's short code for Brazil South, not Microsoft's. The resource group takes the name of the main resource it holds, prefixed with `rg-`: `rg-vnet-core-prod-brs-01`.

Two rules from that documentation weigh here. Most names can't be changed after creation, so only what is permanent goes in the name (the rest goes in tags). And some names are global and have their own rules: according to the [naming rules table](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules), Key Vault accepts 3 to 24 characters with letters, numbers and hyphens, and ACR accepts 5 to 50 characters and **letters and numbers only**. That's why the registry is called `crcoreprodbrs01`.

The resource name becomes the state name: the network `tfstate` is `vnet-core-prod-brs-01.tfstate`, and anyone opening the state container sees exactly what each blob holds.

### Who owns what

The question that defines the split is "who changes this, and how often". For this architecture:

| Stack (folder) | Resources | Modules | State `key` |
|---|---|---|---|
| `vnet-core` | VNet, subnets, NSGs, Private DNS zones | `network` | `vnet-core-prod-brs-01.tfstate` |
| `aks-core` | AKS, ACR and its Private Endpoint | `aks`, `acr`, `private-endpoint` | `aks-core-prod-brs-01.tfstate` |
| `app-orders` | Dedicated PostgreSQL, Key Vault and its Private Endpoint, the application's identity | `postgresql`, `key-vault`, `private-endpoint`, `workload-identity` | `app-orders-prod-brs-01.tfstate` |
| *(outside Terraform)* | Argo CD (bootstrap) and the `orders` pod | Bootstrap script and manifests in `infra/argocd` | no state |

Two details. The `private-endpoint` module is used by two stacks, which is the kind of reuse that justifies a module: HashiCorp's refactoring guide recommends grouping into a module the set of resources you create in several configurations. And the `aks-core` stack also holds the ACR: it takes the name of its main resource, and the registry is support.

### Two design decisions

**PostgreSQL is dedicated to the application and enters as a module call in its stack.** I don't create a shared server in a "data" stack. `orders` asks for its database the same way it asks for the Key Vault and the identity, and the database lifecycle follows the application's. Size, SKU and storage are parameters of the call. It's my choice, with pros and cons:

- **Pros:** blast radius per application, privilege per application, sizing per application and complete removal when it goes away.
- **Cons:** more servers to pay for and operate (backup, patching, monitoring). If many small applications share the same usage profile, a shared server may make more sense. Evaluate with your own numbers.

**The pod enters the cluster through Argo CD, not Terraform.** The criterion is HashiCorp's: group by volatility and separate stateful from stateless. The application changes several times a day and is stateless. The database changes rarely and holds data. If the pod were a Terraform resource, every new image version would go through `plan` and `apply` in the same state as the database. With GitOps, the most frequent step becomes a commit to the manifests, away from the state that can least afford a mistake. Applying the rule to the Argo CD case is **my reading**, since HashiCorp's page doesn't mention GitOps.

---

## How the repository and the state are organized

### Repository layout

```text
infra/
├── modules/                  # reusable pieces, no state of their own
│   ├── network/              # VNet, subnets, NSGs, private DNS zones
│   ├── private-endpoint/     # reused by Key Vault and ACR
│   ├── postgresql/
│   ├── key-vault/
│   ├── workload-identity/
│   ├── acr/
│   └── aks/
├── stacks/                   # each folder is a Terraform root = one tfstate per instance
│   ├── vnet-core/
│   ├── aks-core/
│   └── app-orders/
├── envs/
│   ├── dev-brs-01.tfvars
│   ├── hml-brs-01.tfvars
│   └── prod-brs-01.tfvars
├── argocd/                   # GitOps: Argo CD and the applications' manifests
│   ├── bootstrap/
│   ├── apps/
│   └── manifests/
├── scripts/
│   ├── tf.sh
│   └── bootstrap-argocd.sh
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/
        ├── terraform-stack.yml
        └── argocd-bootstrap.yml
```

The rule I follow:

- A **module** is the *how*: a reusable recipe. It lives directly in `modules/<resource>`, named after the domain (`network`, `aks`, `postgresql`), with no subfolders per team or project. No backend, no state.
- A **stack** is the *what and where*: a Terraform root that calls modules, has its own backend and is what the pipeline executes. The folder name already carries type and name (`vnet-core`, `app-orders`).
- An **instance** (environment, region and sequence) is just data: a `.tfvars` and a different `key` in the backend. `prod-brs-01` and `dev-brs-01` run the same code.

This separation has an academic parent. In the classic [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) (Parnas, CACM, 1972), the abstract says the effectiveness of a modularization depends on the criteria used to divide the system. It's a paper about software, not IaC, so the link is **my reading**, but the question holds before creating folders: split by what? I split by lifecycle and owner, not by size or resource type.

### The backend: one state per stack and per instance

Each stack declares an empty backend and receives the rest at `init` (what Terraform calls *partial configuration*):

```hcl
# infra/stacks/aks-core/main.tf
terraform {
  required_version = "~> 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  features {}
}
```

`init` sets the `key`, which in `azurerm` is the blob name inside the container:

```bash
terraform init -input=false \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=sttfstatecorp001" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=aks-core-prod-brs-01.tfstate"
```

In the end, the container looks like this:

```text
tfstate/
├── vnet-core-dev-brs-01.tfstate
├── vnet-core-prod-brs-01.tfstate
├── aks-core-dev-brs-01.tfstate
├── aks-core-prod-brs-01.tfstate
├── app-orders-dev-brs-01.tfstate
└── app-orders-prod-brs-01.tfstate
```

Two things to look after: the state account should live outside what Terraform manages in the stacks, and authentication should use Microsoft Entra ID, not access keys. The [docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) mark the access key as "not recommended for new workloads" and list `Storage Blob Data Contributor` on the container as the least-privilege option.

### How one stack sees another

`aks-core` and `app-orders` need the subnet and DNS zones from `vnet-core`, and `app-orders` needs the cluster's OIDC issuer. There are two ways to read that:

- **`terraform_remote_state`:** reads the other stack's state outputs. Direct, but the reader needs access to the whole state (which may hold sensitive data) and is coupled to its layout.
- **Provider data source:** queries the real resource through the Azure API. It requires a naming convention (the pattern above plays that role), but the coupling is looser and nobody needs access to someone else's state. For the OIDC issuer, the `azurerm_kubernetes_cluster` data source exposes `oidc_issuer_url`.

HashiCorp doesn't forbid sharing outputs: it recommends exposing only the necessary ones (through `tfe_outputs`) precisely to reduce the risk of leaking sensitive data from the state. I use data sources by default and `remote_state` when the output doesn't exist as a queryable resource. That preference is **mine**, not a HashiCorp rule.

On coupling, DORA's [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) capability states that in tightly coupled architectures small changes can cause cascading failures. It is about software and teams (an analogy, again), but the reasoning holds: the less one stack knows about the other, the less a change spreads.

The full code of each stack and module is in the [Appendix](#appendix-stack-and-module-code). One detail from the provider's PostgreSQL example: it uses `depends_on` on the link between the DNS zone and the VNet. With the split into stacks, that `depends_on` becomes **execution order**: `vnet-core` runs first. That's what the pipeline's `dependsOn` guarantees, right below.

---

## Pipeline parameters

Now the center of the article. The pipeline receives one parameter per step, and only the ticked steps run. The steps are the three Terraform stacks and the Argo CD bootstrap (once per cluster). After the bootstrap, the application evolves through Git.

### Azure DevOps

Azure Pipelines has [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): you declare a type, a default and, optionally, a list of allowed values, and the **Run pipeline** screen builds the form. Three types cover what we want: `string` with `values` (a list of options), `boolean` (a checkbox) and `object` (richer structures).

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # always an intentional run; see "Traps"

parameters:
  - name: environment
    displayName: Environment
    type: string
    default: dev
    values: [dev, hml, prod]

  - name: instance
    displayName: Instance (region-seq)
    type: string
    default: brs-01
    values: [brs-01]          # new instances (another region, another stamp) go here

  - name: action
    displayName: Action
    type: string
    default: plan
    values: [plan, apply]

  - name: vnetCore
    displayName: "vnet-core · private network"
    type: boolean
    default: false

  - name: aksCore
    displayName: "aks-core · cluster and ACR"
    type: boolean
    default: false

  - name: appOrders
    displayName: "app-orders · dedicated PostgreSQL, Key Vault and identity"
    type: boolean
    default: false

  - name: argocd
    displayName: "argocd · install and root Application (once per cluster)"
    type: boolean
    default: false

stages:
  - ${{ if eq(parameters.vnetCore, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: vnet-core
          stageName: vnet_core
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}

  - ${{ if eq(parameters.aksCore, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: aks-core
          stageName: aks_core
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}
          dependsOn:
            - ${{ if eq(parameters.vnetCore, true) }}:
                - vnet_core

  - ${{ if eq(parameters.appOrders, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: app-orders
          stageName: app_orders
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}
          dependsOn:
            - ${{ if eq(parameters.vnetCore, true) }}:
                - vnet_core
            - ${{ if eq(parameters.aksCore, true) }}:
                - aks_core

  - ${{ if eq(parameters.argocd, true) }}:
      - template: templates/argocd-bootstrap.yml
        parameters:
          stageName: argocd
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          dependsOn:
            - ${{ if eq(parameters.aksCore, true) }}:
                - aks_core
            - ${{ if eq(parameters.appOrders, true) }}:
                - app_orders
```

The key is the `${{ if ... }}` expressions. They are **template expressions**, resolved when the pipeline is assembled ([template expressions docs](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)). That means the stage of an unticked step **doesn't exist** in the run: it doesn't show up as "skipped" and doesn't use an agent.

The conditional `dependsOn` lists solve an annoying detail: declaring a dependency on a stage that wasn't included makes validation fail. Here each dependency only exists when the corresponding step was ticked, and the list is empty when none was. I used the conditional insertion into sequences that the docs describe, but I haven't run this exact format.

The template for each stack does `init`, `plan` and, if the action is `apply`, the `apply` with approval:

```yaml
# infra/pipelines/templates/terraform-stack.yml
parameters:
  - name: stack
    type: string
  - name: stageName
    type: string
  - name: environment
    type: string
  - name: instance
    type: string
  - name: action
    type: string
  - name: dependsOn
    type: object
    default: []

stages:
  - stage: ${{ parameters.stageName }}
    displayName: "${{ parameters.stack }}-${{ parameters.environment }}-${{ parameters.instance }}"
    dependsOn: ${{ parameters.dependsOn }}
    jobs:
      - job: plan
        pool:
          name: private-agents   # self-hosted, inside the VNet (see Figure 2)
        steps:
          - task: AzureCLI@2
            displayName: terraform init + plan
            inputs:
              azureSubscription: sc-terraform-${{ parameters.environment }}
              scriptType: bash
              scriptLocation: scriptPath
              scriptPath: infra/scripts/tf.sh
              arguments: plan ${{ parameters.stack }} ${{ parameters.environment }} ${{ parameters.instance }}
              addSpnToEnvironment: true
            env:
              SYSTEM_ACCESSTOKEN: $(System.AccessToken)
              SYSTEM_OIDCREQUESTURI: $(System.OidcRequestUri)
          - publish: $(Build.ArtifactStagingDirectory)/${{ parameters.stack }}.tfplan
            artifact: plan-${{ parameters.stageName }}

      - ${{ if eq(parameters.action, 'apply') }}:
          - deployment: apply
            dependsOn: plan
            pool:
              name: private-agents
            environment: azure-${{ parameters.environment }}
            strategy:
              runOnce:
                deploy:
                  steps:
                    - checkout: self
                    - download: current
                      artifact: plan-${{ parameters.stageName }}
                    - task: AzureCLI@2
                      displayName: terraform apply
                      inputs:
                        azureSubscription: sc-terraform-${{ parameters.environment }}
                        scriptType: bash
                        scriptLocation: scriptPath
                        scriptPath: infra/scripts/tf.sh
                        arguments: apply ${{ parameters.stack }} ${{ parameters.environment }} ${{ parameters.instance }}
                        addSpnToEnvironment: true
                      env:
                        SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                        SYSTEM_OIDCREQUESTURI: $(System.OidcRequestUri)
```

The Argo CD bootstrap template uses the same Environment, and therefore the same approvals, with a dedicated service connection:

```yaml
# infra/pipelines/templates/argocd-bootstrap.yml
parameters:
  - name: stageName
    type: string
  - name: environment
    type: string
  - name: instance
    type: string
  - name: dependsOn
    type: object
    default: []

stages:
  - stage: ${{ parameters.stageName }}
    displayName: "argocd-bootstrap-${{ parameters.environment }}-${{ parameters.instance }}"
    dependsOn: ${{ parameters.dependsOn }}
    jobs:
      - deployment: bootstrap
        pool:
          name: private-agents
        environment: azure-${{ parameters.environment }}
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  displayName: install Argo CD and the root Application
                  inputs:
                    azureSubscription: sc-aks-bootstrap-${{ parameters.environment }}
                    scriptType: bash
                    scriptLocation: scriptPath
                    scriptPath: infra/scripts/bootstrap-argocd.sh
                    arguments: ${{ parameters.environment }} ${{ parameters.instance }}
```

What matters in this design:

- **One service connection for Terraform** (`sc-terraform-prod`) **and another for the bootstrap** (`sc-aks-bootstrap-prod`), with identity federation: whoever applies infrastructure doesn't need to touch workloads, and vice versa.
- **The `private-agents` pool sits inside the VNet**, because ACR (and, if you close it, the state) doesn't accept public access and the cluster API is private.
- **Approval lives in the Environment**, not in the YAML. According to the [documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), approvals and checks aren't defined in the YAML, and whoever edits the YAML can't change them.
- **The `plan` is published as an artifact and `apply` applies that plan**: what was reviewed is what gets applied.

The script both Terraform steps use:

```bash
#!/usr/bin/env bash
# infra/scripts/tf.sh  ->  tf.sh <plan|apply> <stack> <env> <instance>
set -euo pipefail

cmd="$1"; stack="$2"; env="$3"; instance="$4"
suffix="${env}-${instance}"                         # prod-brs-01
state_key="${stack}-${suffix}.tfstate"              # vnet-core-prod-brs-01.tfstate
stage="${stack//-/_}"                               # app-orders -> app_orders
plan_file="${BUILD_ARTIFACTSTAGINGDIRECTORY:-$PWD}/${stack}.tfplan"

export ARM_USE_OIDC=true
export ARM_USE_AZUREAD=true
export ARM_CLIENT_ID="$servicePrincipalId"   # exposed by the AzureCLI@2 task
export ARM_TENANT_ID="$tenantId"
export ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID="$AZURESUBSCRIPTION_SERVICE_CONNECTION_ID"  # required by the provider on Azure DevOps
export ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"

cd "infra/stacks/${stack}"

terraform init -input=false \
  -backend-config="resource_group_name=${TFSTATE_RG}" \
  -backend-config="storage_account_name=${TFSTATE_SA}" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=${state_key}"

case "$cmd" in
  plan)
    terraform plan -input=false \
      -var="environment=${env}" -var="instance=${instance}" \
      -var-file="../../envs/${suffix}.tfvars" \
      -out="${plan_file}"
    ;;
  apply)
    terraform apply -input=false \
      "${PIPELINE_WORKSPACE}/plan-${stage}/${stack}.tfplan"
    ;;
esac
```

> **A note on authentication in Azure DevOps.** The [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) task exposes `$servicePrincipalId` and `$tenantId` when `addSpnToEnvironment: true` and the service connection uses federation. For the **backend**, the [`azurerm` docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) say the OIDC token endpoints are found automatically on Azure DevOps. For the **provider**, the [OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) uses `SYSTEM_ACCESSTOKEN` and `SYSTEM_OIDCREQUESTURI` (hence the tasks' `env:`) and requires the service connection ID in `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. Reusing `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` in that variable is **my reading**: the guide uses its own variable.

### GitHub Actions

On GitHub, the equivalent is `workflow_dispatch` with `inputs`. The types are `string`, `choice`, `boolean`, `environment` and `number` ([input types changelog](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)). The `environment` type lists the repository's Environments as options. Since December 2025 the limit is [25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/) (it used to be 10).

```yaml
# .github/workflows/infra.yml
name: infra

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Environment (GitHub Environment)
        type: environment
        required: true
      instance:
        description: Instance (region-seq)
        type: choice
        options: [brs-01]
        default: brs-01
      action:
        description: Action
        type: choice
        options: [plan, apply]
        default: plan
      vnet_core:
        description: "vnet-core · private network"
        type: boolean
        default: false
      aks_core:
        description: "aks-core · cluster and ACR"
        type: boolean
        default: false
      app_orders:
        description: "app-orders · dedicated PostgreSQL, Key Vault and identity"
        type: boolean
        default: false
      argocd:
        description: "argocd · install and root Application (once per cluster)"
        type: boolean
        default: false

permissions:
  id-token: write
  contents: read

jobs:
  vnet-core:
    if: ${{ inputs.vnet_core }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: vnet-core
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  aks-core:
    needs: [vnet-core]
    if: ${{ !cancelled() && !failure() && inputs.aks_core }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: aks-core
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  app-orders:
    needs: [vnet-core, aks-core]
    if: ${{ !cancelled() && !failure() && inputs.app_orders }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: app-orders
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  argocd:
    needs: [aks-core, app-orders]
    if: ${{ !cancelled() && !failure() && inputs.argocd }}
    uses: ./.github/workflows/argocd-bootstrap.yml
    with:
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
```

There is an important difference from Azure DevOps here: the condition is evaluated **at runtime**, so an unticked job shows up as *skipped*. According to the [documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), a job that depends on a failed or skipped one is skipped too, unless it uses a conditional expression that lets it continue. `!cancelled() && !failure()` does that: "run if nothing failed, even if the dependency was skipped". Another detail: the `inputs` context preserves booleans, while `github.event.inputs` converts everything to strings. That's why the `if` uses `inputs.vnet_core` directly.

The Terraform reusable workflow:

```yaml
# .github/workflows/terraform-stack.yml
name: terraform-stack

on:
  workflow_call:
    inputs:
      stack:       { type: string, required: true }
      environment: { type: string, required: true }
      instance:    { type: string, required: true }
      action:      { type: string, required: true }

permissions:
  id-token: write
  contents: read

jobs:
  terraform:
    runs-on: [self-hosted, linux, private-vnet]   # runner inside the VNet (see Figure 2)
    environment: ${{ inputs.environment }}
    env:
      ARM_USE_OIDC: "true"
      ARM_USE_AZUREAD: "true"
      ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
      ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}
      ARM_SUBSCRIPTION_ID: ${{ vars.AZURE_SUBSCRIPTION_ID }}
    defaults:
      run:
        working-directory: infra/stacks/${{ inputs.stack }}
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3

      - name: init
        run: |
          terraform init -input=false \
            -backend-config="resource_group_name=${{ vars.TFSTATE_RG }}" \
            -backend-config="storage_account_name=${{ vars.TFSTATE_SA }}" \
            -backend-config="container_name=tfstate" \
            -backend-config="key=${{ inputs.stack }}-${{ inputs.environment }}-${{ inputs.instance }}.tfstate"

      - name: plan
        run: |
          terraform plan -input=false -out=tfplan \
            -var="environment=${{ inputs.environment }}" \
            -var="instance=${{ inputs.instance }}" \
            -var-file="../../envs/${{ inputs.environment }}-${{ inputs.instance }}.tfvars"

      - name: apply
        if: ${{ inputs.action == 'apply' }}
        run: terraform apply -input=false tfplan
```

And the Argo CD bootstrap one:

```yaml
# .github/workflows/argocd-bootstrap.yml
name: argocd-bootstrap

on:
  workflow_call:
    inputs:
      environment: { type: string, required: true }
      instance:    { type: string, required: true }

permissions:
  id-token: write
  contents: read

jobs:
  bootstrap:
    runs-on: [self-hosted, linux, private-vnet]   # must reach the AKS private API
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_BOOTSTRAP_CLIENT_ID }}   # the bootstrap's own identity
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: install Argo CD and the root Application
        run: ./infra/scripts/bootstrap-argocd.sh "${{ inputs.environment }}" "${{ inputs.instance }}"
```

The runner needs `az` and `kubectl` installed. The login uses the `azure/login` action, which is the flow in [GitHub's documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure), and `bootstrap-argocd.sh` is the same script as in Azure DevOps.

What matters on GitHub:

- **Reusable workflows** are called at the job level and receive `inputs` through `with` ([docs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)). The job that calls the reusable workflow can't use `environment`: the job inside it declares it, as we did.
- **OIDC authentication, no secrets.** The provider detects the GitHub Actions variables on its own, as long as the workflow has `id-token: write` ([provider OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)).
- **One federated credential per environment.** With an Environment on the job, the token *subject* is `repo:ORG/REPO:environment:NAME`, so `prod` only accepts tokens from jobs in the `prod` Environment. Mind this: repositories created after July 15, 2026 use an immutable subject with the owner and repository IDs by default ([OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)), and [Microsoft recommends migrating](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) name-based credentials. Confirm what the environment subject looks like in your repository, because the docs only show the immutable example with a branch.
- **Plan and apply in the same job.** If the Environment has *required reviewers*, approval is requested **before** the plan. If that bothers you, use two Environments (`dev-plan` and `dev-apply`) or split into two jobs.

### Azure DevOps or GitHub Actions?

| Point | Azure DevOps | GitHub Actions |
|---|---|---|
| Run parameter | `parameters` with `type` and `values` | `workflow_dispatch.inputs` |
| When selection applies | At assembly: the stage doesn't exist | At execution: the job shows as skipped |
| Approval | Environment with approvals and checks | Environment with required reviewers |
| Reuse | Templates (`template:`) | Reusable workflows (`workflow_call`) |
| Authentication | Service connection with federation | OIDC with a federated credential per Environment |
| Limit that bit me | Parameters need a `default`; trigger runs use the defaults | 25 inputs; up to 10 chained workflow levels |

Neither is better at everything. The difference between "missing stage" and "skipped job" looks small, but it changes how you read run history and how you set up dependencies.

---

## Application deploy with Argo CD

With the infrastructure up, the `orders` pod enters the cluster through **Argo CD**, which the [documentation](https://argo-cd.readthedocs.io/en/stable/) describes as a declarative GitOps continuous delivery tool for Kubernetes: Git is the source of truth for the desired state, and a controller continuously compares the live state against it. Manifests can be Kustomize, Helm charts or a directory of YAML.

This changes two things in the pipeline. The application deploy stops being one of its steps and becomes a commit in Git. And the pipeline only installs Argo CD, once per cluster (the **bootstrap**).

### The `infra/argocd` directory

```text
infra/argocd/
├── bootstrap/
│   └── root-prod-brs-01.yaml        # root Application (app of apps), applied by the pipeline
├── apps/
│   └── prod-brs-01/
│       └── orders.yaml              # Application for the orders application
└── manifests/
    └── orders/
        ├── base/                    # ServiceAccount, Deployment, Service...
        └── overlays/
            └── prod-brs-01/
                └── kustomization.yaml
```

- `bootstrap/` is what the pipeline applies once: the instance's root Application.
- `apps/` has one Application per application and per instance. The root watches this directory.
- `manifests/` has what each Application syncs: a base and one overlay per instance.

The root follows the *app of apps* pattern from the [cluster bootstrapping documentation](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/). The same page recommends looking at ApplicationSets for most scenarios; I chose app of apps because it's simpler to show. The doc uses a Helm example and says you can use another tool, so I used a directory of manifests (I haven't run this exact format).

```yaml
# infra/argocd/bootstrap/root-prod-brs-01.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-prod-brs-01
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/<repo>.git   # or the repository on Azure Repos
    targetRevision: main
    path: infra/argocd/apps/prod-brs-01
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: {}      # no prune: the default is not to delete what left Git
```

The application's Application points to the instance's overlay. The format is that of a [minimal Application](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/), and the `resources-finalizer.argocd.argoproj.io` finalizer makes deleting the Application also delete what it manages (without it, the doc warns that doesn't happen):

```yaml
# infra/argocd/apps/prod-brs-01/orders.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: orders-prod-brs-01
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/<repo>.git
    targetRevision: main
    path: infra/argocd/manifests/orders/overlays/prod-brs-01
  destination:
    server: https://kubernetes.default.svc
    namespace: orders
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
    # no "automated": in prod the sync is manual, after the PR merge
```

`CreateNamespace=true` creates the destination namespace if it doesn't exist ([sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)). In the example's prod there is no `syncPolicy.automated`: merging the pull request updates Git, and syncing is manual. In dev and hml I would use `automated`, which is optional and, by default, [doesn't delete what left Git](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/).

The manifests live in a base, with what is the same across all instances, and in one overlay per instance. Since there is a `kustomization.yaml` at the path, Argo CD renders with Kustomize ([docs](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)). The two names Workload Identity requires are in the [AKS documentation](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster): the `azure.workload.identity/client-id` annotation on the service account and the `azure.workload.identity/use: "true"` label on the pods.

```yaml
# infra/argocd/manifests/orders/base/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders
  annotations:
    azure.workload.identity/client-id: "00000000-0000-0000-0000-000000000000"   # overridden in the overlay
```

```yaml
# infra/argocd/manifests/orders/base/deployment.yaml (excerpt)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: orders
      containers:
        - name: orders
          image: orders
          envFrom:
            - configMapRef:
                name: orders-config
```

```yaml
# infra/argocd/manifests/orders/overlays/prod-brs-01/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

images:
  - name: orders
    newName: crcoreprodbrs01.azurecr.io/orders
    newTag: "1.8.3"

configMapGenerator:
  - name: orders-config
    literals:
      - DB_HOST=<postgres_fqdn>                  # output of the app-orders stack

patches:
  - target:
      kind: ServiceAccount
      name: orders
    patch: |-
      - op: replace
        path: /metadata/annotations/azure.workload.identity~1client-id
        value: "<app_client_id>"                 # output of the app-orders stack
```

The `subject` of the `workload-identity` module (`system:serviceaccount:orders:orders`) must match the Application's namespace and the service account name. The two overlay values that come from Terraform (`app_client_id` and `postgres_fqdn`) are outputs of the `app-orders` stack. How they reach Git is up to you (copy them in the PR that changes Terraform, or a step that opens that PR), but the bridge needs to be explicit. No secret goes into Git: the application reads Key Vault through Workload Identity.

### The bootstrap

The script installs Argo CD with the command from the [installation documentation](https://argo-cd.readthedocs.io/en/stable/getting_started/) and applies the instance's root Application:

```bash
#!/usr/bin/env bash
# infra/scripts/bootstrap-argocd.sh  ->  bootstrap-argocd.sh <env> <instance>
set -euo pipefail

env="$1"; instance="$2"
suffix="${env}-${instance}"                       # prod-brs-01
argocd_version="v3.2.0"                           # pin the version; check the current one

az aks get-credentials \
  --resource-group "rg-aks-core-${suffix}" \
  --name "aks-core-${suffix}" \
  --overwrite-existing

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n argocd --server-side --force-conflicts \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${argocd_version}/manifests/install.yaml"

kubectl apply -n argocd -f "infra/argocd/bootstrap/root-${suffix}.yaml"
```

- The doc uses `--server-side --force-conflicts` because some CRDs (like ApplicationSet) exceed the annotation size limit of client-side `kubectl apply`, and recommends pinning a version in production. `v3.2.0` is the doc's own example: check the current one.
- `az aks get-credentials` needs network and DNS access to the private API, so the bootstrap runs on the self-hosted agent. The agent and the cluster also need to reach the origin of `install.yaml` and the images, which goes back to the egress design I left out.
- If the Git repository is private, Argo CD needs credentials: the [doc](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/) lists HTTPS, SSH and GitHub App. How to provision them I didn't cover.

### How the application changes afterwards

A new `orders` version becomes a change to the overlay's `newTag`, in a pull request. The review of that PR is the deploy approval, and the repository's branch policy is the control. In prod, the next step is the manual sync. At no point does the infrastructure pipeline come into play, nor does it need to reach the cluster API.

---

## Traps I've seen

1. **A parameter is not a vault.** Microsoft warns that parameter values are expanded when the template is parsed and may show up in logs. The [*Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) study (Rahman, Parnin and Williams, ICSE 2019) analyzed 15,232 IaC scripts, found 21,201 security smells (1,326 of them hard-coded passwords) and showed a hard-coded secret can persist for up to 98 months. Keep credentials in secret variables or Key Vault, and restrict the allowed parameter values.
2. **Partial selection creates drift.** If someone ticks only the cluster after a network change that wasn't applied, the plan fails or, worse, runs on an outdated base. I use `plan` as the default action and a scheduled job that runs `plan` on everything to detect drift.
3. **Execution and destroy order.** On create: `vnet-core`, `aks-core`, `app-orders` and the Argo CD bootstrap. On `destroy` it's the reverse, and the database holds data. So I don't offer `destroy` as an `action` value in `prod`.
4. **The bridge between Terraform and Git.** If the `orders` Application enters Git before the database and the identity exist, the pod starts without being able to connect: apply the `app-orders` stack before merging the PR that creates the Application. And if someone recreates the database or the identity and forgets to update the overlay, Argo CD keeps syncing the old values, because as far as it is concerned Git is right.
5. **Who can click "Run" is part of access control.** The parameter form is an infrastructure control interface: restrict who can run the pipeline and protect the production Environment. And if you attach a `trigger`, remember the automatic run uses the default values (hence `trigger: none` and `default: false`).
6. **Splitting too much.** Twenty small states become twenty dependency points. Split by lifecycle and owner, not by size (Parnas's criterion, again).
7. **A private network also closes your pipeline's door.** Plan the self-hosted agent or runner inside the VNet from the start. With Argo CD, the pipeline only needs the API at the bootstrap, but the cluster now needs to reach out to Git.
8. **Argo CD has traps too.** The doc warns that app of apps is an admin capability: only admins should have push access to the parent Application's repository, and pull requests need review, paying attention to the `project` field. Protect `infra/argocd/apps` with a branch policy. And remember automated sync only deletes what left Git if you enable pruning, and that with the finalizer, deleting an Application deletes what it manages. Decide this on purpose, especially in prod.

---

## Pros, cons and when I wouldn't use it

**Pros**

- Smaller blast radius and changes that are easier to review.
- Least privilege per stack, per environment and per application.
- Faster plans and no lock contention.
- One pipeline to maintain, with the same code in every instance.
- Modules reused across stacks (the `private-endpoint`).
- Dedicated database per application, with the application's lifecycle.
- Frequent deploys through Git, away from the state that can least afford a mistake, and auditable: the commit history and the PR review are the record and the approval.
- Names that say what each resource and each state holds.

**Cons**

- More moving parts to understand: modules, stacks, backends, templates, manifests.
- Dependencies between stacks become explicit and are your responsibility, including the Terraform → manifests bridge.
- Migrating from a big state needs planning. The [refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) says to run `terraform plan` on the source configuration and confirm nothing will change.
- Manual selection opens room for human error without guard rails (approvals, allowed values, `plan` as default).
- A database per application increases cost and operations.
- One more component to operate (Argo CD) and a cluster that needs to reach Git.
- A private network requires agents inside the network and careful DNS design.

**When I wouldn't use it.** With a single environment, few resources and a team of one or two people, a single state and a simple pipeline cost less than all of this. The design pays off when the state starts to hurt: slow plans, contended locks, fear of touching what you shouldn't. Start with what changes most, or with what would be most expensive to break (usually network and data), and go from there.

---

## Checklist to get started

- [ ] Map resources by lifecycle, owner and stateful/stateless before splitting
- [ ] Define the naming pattern (`type-name-environment-region-seq`) before the first `apply`, because most names can't change afterwards
- [ ] Extract modules for what repeats, with a direct domain name in `modules/<resource>`
- [ ] One stack per Terraform root, with an empty `backend "azurerm" {}`
- [ ] State `key` = `<stack>-<environment>-<region>-<seq>.tfstate`
- [ ] Authentication through identity federation, no secrets
- [ ] Parameters: `environment` and `instance` with a closed list, `action` defaulting to `plan`, one boolean per step
- [ ] Approval on the production Environment, for Terraform and for the Argo CD bootstrap
- [ ] Saved `plan` applied as an artifact
- [ ] Dedicated database as a module call in the application's stack, if that is your model
- [ ] Deploy through Argo CD, with manifests in `infra/argocd` and one Application per instance
- [ ] Production deploy approval on the pull request (branch policy) and, if you prefer, manual sync
- [ ] Self-hosted agents or runners inside the VNet, if the network is private
- [ ] Scheduled `plan` job to detect drift
- [ ] Document the dependency order between steps

---

## FAQ

**Why not a single state with `-target`?**
I've seen people try: one state, and a parameter passing `-target=module.aks`. Terraform's [documentation](https://developer.hashicorp.com/terraform/cli/commands/plan) says to use `-target` only in exceptional circumstances (such as recovering from mistakes) and that it isn't recommended for routine operations. It doesn't fix the lock, the refresh time, the blast radius or permission separation. It's the checkbox without half of the design.

**Can I use `object` or `stringList` instead of several booleans in Azure DevOps?**
Yes. `object` lets you iterate with `${{ each }}`, and `stringList` lets you tick several items in a list, but the doc warns it isn't available in templates. The cost is an input that's less friendly than checkboxes and dependencies that are harder to assemble. I haven't tested those variations. For a few steps I prefer booleans, and to run everything at once you just tick them all.

**Why Argo CD, and not a pipeline deploy or Terraform's Helm provider?**
Because the application changes far more often than the database and the network, and HashiCorp's volatility rule points to keeping that step out of the infrastructure state. Argo CD also keeps the cluster reconciled with Git, and the pipeline doesn't need to reach the private API on every deploy. It's a design choice of mine: if your team doesn't want to operate Argo CD, Helm in the pipeline works too. And Argo CD accepts Helm charts, Kustomize and directories of YAML ([docs](https://argo-cd.readthedocs.io/en/stable/)), so you can keep charts in place of the overlay.

**Why does PostgreSQL use a delegated subnet and not a Private Endpoint?**
Because I chose network integration (private access). The [documentation](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) presents two options for PostgreSQL Flexible Server: private access (what I used) or public access with a Private Endpoint. Check what changes in each before creating the server.

**Does this work with Bicep or OpenTofu?**
The design of parameters, independent stacks and a single pipeline works for any IaC. What's Terraform-specific here is `tfstate` and the backend. OpenTofu uses the same `azurerm` backend model, but confirm the particulars in its documentation.

**How do I migrate from a single state?**
Plan the grouping, move resources with `removed` and `import` blocks (HashiCorp's refactoring guide details it), and confirm `terraform plan` shows no changes in any stack. Start in dev.

---

## Closing

The checkbox in the pipeline is just the visible tip. What holds the idea up is the design underneath: modules that concentrate the *how*, stacks that isolate the *what*, states that isolate the *impact*, names that say what each thing is and identities that isolate the *who*. With that in place, the parameter is just the way you choose.

If you only have one state today, you don't need to split everything at once. Pick the part that hurts most and start there. If you've done this split another way, I'd like to hear what worked and what didn't in your case.

---

## Appendix: stack and module code

The snippets below show the three stacks and the modules cited in the text. All stacks receive `environment` and `instance` and derive their names from the same suffix (`prod-brs-01`).

**`vnet-core`** calls the `network` module and owns the VNet, the subnets and the DNS zones:

```hcl
# infra/stacks/vnet-core/main.tf (terraform {} and provider as in the backend example)
variable "environment" { type = string }   # prod
variable "instance"    { type = string }   # brs-01

locals {
  name   = "core"
  suffix = "${var.environment}-${var.instance}"   # prod-brs-01
}

module "network" {
  source = "../../modules/network"

  name          = "vnet-${local.name}-${local.suffix}"      # vnet-core-prod-brs-01
  address_space = ["10.10.0.0/16"]

  subnets = {
    "snet-aks-${local.suffix}"       = { cidr = "10.10.0.0/22" }
    "snet-endpoints-${local.suffix}" = { cidr = "10.10.4.0/27" }
    "snet-postgres-${local.suffix}"  = { cidr = "10.10.4.32/28", delegation = "Microsoft.DBforPostgreSQL/flexibleServers" }
    "snet-agents-${local.suffix}"    = { cidr = "10.10.4.64/27" }
  }

  private_dns_zones = [
    "privatelink.azurecr.io",
    "privatelink.vaultcore.azure.net",
    "${local.suffix}.postgres.database.azure.com",
  ]
}
```

The module creates the resource group (`rg-vnet-core-prod-brs-01`) and receives the subnet map with an optional delegation attribute:

```hcl
# infra/modules/network/variables.tf (excerpt)
variable "subnets" {
  type = map(object({
    cidr       = string
    delegation = optional(string)
  }))
}
```

**`aks-core`** doesn't create networking. It looks up the subnet and the ACR zone that `vnet-core` created, and creates the registry, the private endpoint and the cluster:

```hcl
# infra/stacks/aks-core/main.tf (continues the terraform/provider block from the backend section)
variable "environment" { type = string }
variable "instance"    { type = string }

locals {
  name       = "core"
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-core-${local.suffix}"
  vnet_name  = "vnet-core-${local.suffix}"
}

data "azurerm_subnet" "aks" {
  name                 = "snet-aks-${local.suffix}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_subnet" "endpoints" {
  name                 = "snet-endpoints-${local.suffix}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_private_dns_zone" "acr" {
  name                = "privatelink.azurecr.io"
  resource_group_name = local.network_rg
}

module "acr" {
  source = "../../modules/acr" # sku = "Premium", public access disabled

  name = "cr${local.name}${var.environment}${replace(var.instance, "-", "")}"   # crcoreprodbrs01 (letters and numbers only)
}

module "acr_private_endpoint" {
  source = "../../modules/private-endpoint"

  name                = "pep-cr-${local.name}-${local.suffix}"   # pep-cr-core-prod-brs-01
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.acr.id
  subresource_name    = "registry"
  private_dns_zone_id = data.azurerm_private_dns_zone.acr.id
}

module "aks" {
  source = "../../modules/aks"

  name      = "aks-${local.name}-${local.suffix}"               # aks-core-prod-brs-01
  subnet_id = data.azurerm_subnet.aks.id
  acr_id    = module.acr.id
}
```

What makes the cluster private and enables Workload Identity lives in the module:

```hcl
# infra/modules/aks/main.tf (excerpt)
resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = var.name

  private_cluster_enabled   = true
  oidc_issuer_enabled       = true
  workload_identity_enabled = true # requires oidc_issuer_enabled

  default_node_pool {
    name           = "system"
    vm_size        = var.vm_size
    node_count     = var.node_count
    vnet_subnet_id = var.subnet_id
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    outbound_type       = var.outbound_type # separate decision, see above
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}
```

**`app-orders`** is the application's stack. The database is a dedicated module call. It looks up the network and DNS zones from `vnet-core` and the cluster's OIDC issuer from `aks-core`:

```hcl
# infra/stacks/app-orders/main.tf (terraform {} and provider as in the backend example)
variable "environment"         { type = string }
variable "instance"            { type = string }
variable "postgres_sku_name"   { type = string }
variable "postgres_storage_mb" { type = number }

locals {
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-core-${local.suffix}"
  vnet_name  = "vnet-core-${local.suffix}"
}

data "azurerm_subnet" "postgres" {
  name                 = "snet-postgres-${local.suffix}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_subnet" "endpoints" {
  name                 = "snet-endpoints-${local.suffix}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_private_dns_zone" "postgres" {
  name                = "${local.suffix}.postgres.database.azure.com"
  resource_group_name = local.network_rg
}

data "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = local.network_rg
}

data "azurerm_kubernetes_cluster" "this" {
  name                = "aks-core-${local.suffix}"
  resource_group_name = "rg-aks-core-${local.suffix}"
}

# Database dedicated to the orders application
module "postgresql" {
  source = "../../modules/postgresql"

  name                = "pgsql-orders-${local.suffix}"   # pgsql-orders-prod-brs-01
  delegated_subnet_id = data.azurerm_subnet.postgres.id
  private_dns_zone_id = data.azurerm_private_dns_zone.postgres.id
  sku_name            = var.postgres_sku_name
  storage_mb          = var.postgres_storage_mb
}

module "key_vault" {
  source = "../../modules/key-vault"

  name = "kv-orders-${local.suffix}"                     # kv-orders-prod-brs-01
}

module "key_vault_private_endpoint" {
  source = "../../modules/private-endpoint"

  name                = "pep-kv-orders-${local.suffix}"
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.key_vault.id
  subresource_name    = "vault"
  private_dns_zone_id = data.azurerm_private_dns_zone.key_vault.id
}

module "workload_identity" {
  source = "../../modules/workload-identity"

  name                 = "id-orders-${local.suffix}"     # id-orders-prod-brs-01
  oidc_issuer_url      = data.azurerm_kubernetes_cluster.this.oidc_issuer_url
  namespace            = "orders"
  service_account_name = "orders"
  key_vault_id         = module.key_vault.id
}

output "postgres_fqdn" { value = module.postgresql.fqdn }
output "app_client_id" { value = module.workload_identity.client_id }
```

In the `postgresql` module, what matters for the private network is this (the [provider's](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server) example uses exactly these attributes):

```hcl
# infra/modules/postgresql/main.tf (excerpt)
resource "azurerm_postgresql_flexible_server" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name

  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false

  sku_name   = var.sku_name
  storage_mb = var.storage_mb

  # version, authentication, backup...
}
```

The `private-endpoint` module, reused by the `aks-core` and `app-orders` stacks:

```hcl
# infra/modules/private-endpoint/main.tf (excerpt)
resource "azurerm_private_endpoint" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.subnet_id

  private_service_connection {
    name                           = var.name
    private_connection_resource_id = var.target_resource_id
    subresource_names              = [var.subresource_name]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_dns_zone_id]
  }
}
```

And the `workload-identity` module, which creates the application's identity and federates it with the Kubernetes service account. The [AKS Workload ID documentation](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster) shows the same resources, including the `Key Vault Secrets User` role:

```hcl
# infra/modules/workload-identity/main.tf (excerpt)
resource "azurerm_user_assigned_identity" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_federated_identity_credential" "this" {
  name                = "fic-${var.name}"
  resource_group_name = var.resource_group_name
  parent_id           = azurerm_user_assigned_identity.this.id
  issuer              = var.oidc_issuer_url
  subject             = "system:serviceaccount:${var.namespace}:${var.service_account_name}"
  audience            = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}
```

The example Key Vault uses RBAC (`rbac_authorization_enabled = true`) and `public_network_access_enabled = false`, documented attributes of the [`azurerm_key_vault`](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault) resource.

If modules live in another repository, `source` points to a tag so the version is pinned: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## References

**Azure DevOps and GitHub Actions**
- [Azure Pipelines — Runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters)
- [Azure Pipelines — Template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)
- [Azure Pipelines — Approvals and checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
- [Azure Pipelines — AzureCLI@2 task](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2)
- [GitHub — Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch now supports 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub — OIDC in Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — GitHub immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)

**Terraform**
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — terraform plan and `-target`](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [HashiCorp — azurerm backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)
- [azurerm — OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)
- [azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)

**Argo CD**
- [Overview](https://argo-cd.readthedocs.io/en/stable/)
- [Installation (getting started)](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [Cluster bootstrapping (app of apps)](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
- [Declarative setup (Application)](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [Sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)
- [Kustomize](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)
- [Private repositories](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/)

**Reference architecture (private network)**
- [AKS — Private clusters](https://learn.microsoft.com/en-us/azure/aks/private-clusters)
- [AKS — Access a private cluster](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster)
- [AKS — Workload Identity: deploy and configure](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster)
- [PostgreSQL Flexible Server — Networking with private access](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
- [Azure Container Registry — Private Link](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)
- [Key Vault — Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)
- [Private Endpoint — DNS zones](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
- [Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)

**Naming and standards**
- [Cloud Adoption Framework — Resource abbreviations](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations)
- [Cloud Adoption Framework — Define your naming convention](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Azure — Naming rules and restrictions for resources](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules)
- [Azure Well-Architected — Safe deployment practices (OE:11)](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments)
- [Azure Landing Zones — Deploy](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy)
- [The Twelve-Factor App — III. Config](https://12factor.net/config)

**Research**
- D. L. Parnas, [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623), Communications of the ACM, 15(12), 1972.
- A. Rahman, C. Parnin, L. Williams, [*The Seven Sins: Security Smells in Infrastructure as Code Scripts*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts), ICSE 2019.
- [DORA — Software delivery performance metrics](https://dora.dev/guides/dora-metrics/)
- [DORA — Deployment automation](https://dora.dev/capabilities/deployment-automation/)
- [DORA — Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/)
- [Accelerate State of DevOps 2024 (DORA)](https://dora.dev/research/2024/dora-report/)
