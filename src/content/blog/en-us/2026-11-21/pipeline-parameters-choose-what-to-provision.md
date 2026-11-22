---
title: "Pipeline parameters: provision only what you choose (Terraform and one tfstate per stack)"
description: "How to use parameters in Azure DevOps and GitHub Actions to choose which Terraform stacks run, with one tfstate per stack and names that say what each thing holds."
pubDate: 2026-11-21
updatedDate: 2026-11-22
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modules", "platform-engineering", "azure"]
readingTime: "18 min"
lang: "en"
draft: false
---

> **TL;DR**
> - Split infrastructure into independent *stacks*, each with its own `tfstate` and built on modules. Make the pipeline take parameters that say **what to run**, **where** and **with which action**.
> - The gain: smaller blast radius, least privilege per stack, faster `plan` and a single pipeline to maintain.
> - The same design works in Azure DevOps (`parameters`) and GitHub Actions (`workflow_dispatch`).
> - Names follow `type-name-environment-region-seq`, and the state name is the resource name.
> - The cost: more moving parts, and dependencies between stacks that become your responsibility.
> - This is **Part 1 of 2**. [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/) shows the reference architecture (AKS and PostgreSQL in a private network) and the application deploy through Argo CD.

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

> **How to read this article.** Every link points to official documentation or published research. When an idea is mine, and not the source's, I mark it as **my reading**. The code is simplified to explain the design: adapt names, versions and permissions to your environment and try it in dev before anything else. If you want to see the parameters working, jump to [Pipeline parameters](#pipeline-parameters). The stack and module code is in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/). **Update (2026-11-22):** I revalidated the code with `terraform validate`, `actionlint`, `shellcheck` and `kustomize build` and fixed what didn't pass: minimum Terraform (1.12) and provider (4.65) versions, the state variables, error handling in `tf.sh` and the note on the service connection.

---

## The idea in one picture

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="A parameter panel (environment, instance, action and one checkbox per stack) feeds a single pipeline that runs only the ticked stacks: vnet-core-prod-brs-01 and aks-core-prod-brs-01. The orders application stack is unticked and does not run. Each stack writes to its own tfstate, named after the resource, in the same Azure Storage container." loading="lazy" />
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

## The example: three stacks

In the examples, I use a platform with three stacks: the network (`vnet-core`), the cluster (`aks-core`) and an application (`app-orders`), with its dedicated database. The architecture itself (private network, Private Endpoints, Argo CD) and the code of each stack are in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/). Here all that matters is how to split, name and trigger.

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
| *(outside Terraform)* | The `orders` pod and Argo CD | Manifests in `infra/argocd` ([Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/)) | no state |

Two details. The `private-endpoint` module is used by two stacks, which is the kind of reuse that justifies a module: HashiCorp's refactoring guide recommends grouping into a module the set of resources you create in several configurations. And the `aks-core` stack also holds the ACR: it takes the name of its main resource, and the registry is support.

### The database belongs to the application

PostgreSQL is dedicated to the application and enters as a module call in its stack, not in a shared "data" stack. The database lifecycle follows the application's, and size, SKU and storage are parameters of the call. It's my choice, with pros and cons I detail in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/). The application's pod, on the other hand, is **not** a Terraform resource: it enters the cluster through GitOps, also in Part 2.

---

## How the repository and the state are organized

### Repository layout

```text
infra/
├── modules/                  # reusable pieces, no state of their own
│   ├── network/
│   ├── private-endpoint/
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
├── scripts/
│   └── tf.sh
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/
        └── terraform-stack.yml
```

The `argocd/` folder and the bootstrap script come in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/).

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
  required_version = ">= 1.12, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.65, < 5.0"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  features {}
}
```

Why `>= 1.12` and `>= 4.65`: OIDC authentication for the backend on Azure DevOps only appears in the [backend documentation](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) from Terraform 1.12, and Part 2 uses provider attributes that arrived after 4.0 (`rbac_authorization_enabled` on Key Vault and `user_assigned_identity_id` on the federated credential). A `~> 1.9` or `~> 4.0` would accept versions without them.

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

The code of each stack and module is in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/). One detail from the provider's PostgreSQL example: it uses `depends_on` on the link between the DNS zone and the VNet. With the split into stacks, that `depends_on` becomes **execution order**: `vnet-core` runs first. That's what the pipeline's `dependsOn` guarantees, right below.

---

## Pipeline parameters

Now the center of the article. The pipeline receives one parameter per step, and only the ticked steps run. The steps are the three Terraform stacks. In [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/) I add a fourth, the Argo CD bootstrap.

### Azure DevOps

Azure Pipelines has [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): you declare a type, a default and, optionally, a list of allowed values, and the **Run pipeline** screen builds the form. Three types cover what we want: `string` with `values` (a list of options), `boolean` (a checkbox) and `object` (richer structures).

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # always an intentional run; see "Traps"

variables:
  - group: tfstate   # TFSTATE_RG and TFSTATE_SA (where the state lives)

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
          name: private-agents   # self-hosted, inside the VNet (see Part 2)
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

What matters in this design:

- **One service connection per environment** (`sc-terraform-prod`), with identity federation, instead of stored credentials.
- **The `private-agents` pool sits inside the VNet**, because ACR (and, if you close it, the state) doesn't accept public access and the cluster API is private (details in [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/)).
- **The state's location comes from a variable group** (`tfstate`, with `TFSTATE_RG` and `TFSTATE_SA`). Without it, the script's `set -u` stops at `init`.
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
ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"   # environment subscription (two lines so set -e catches an az failure)
export ARM_SUBSCRIPTION_ID

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
  *)
    echo "usage: tf.sh <plan|apply> <stack> <env> <instance>" >&2
    exit 2
    ;;
esac
```

> **A note on authentication in Azure DevOps.** The [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) task exposes `$servicePrincipalId` and `$tenantId` when `addSpnToEnvironment: true` and the service connection uses federation. For the **backend**, the [`azurerm` docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) say the OIDC token endpoints are found automatically on Azure DevOps. For the **provider**, the [OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) uses `SYSTEM_ACCESSTOKEN` and `SYSTEM_OIDCREQUESTURI` (hence the tasks' `env:`) and requires the service connection ID in `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. Reusing `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` in that variable is backed by the backend docs themselves: from Terraform 1.12, they say the `AzureCLI` and `AzurePowerShell` tasks set that variable automatically.

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
    runs-on: [self-hosted, linux, private-vnet]   # runner inside the VNet (see Part 2)
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

## Traps I've seen

1. **A parameter is not a vault.** Microsoft warns that parameter values are expanded when the template is parsed and may show up in logs. The [*Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) study (Rahman, Parnin and Williams, ICSE 2019) analyzed 15,232 IaC scripts, found 21,201 security smells (1,326 of them hard-coded passwords) and showed a hard-coded secret can persist for up to 98 months. Keep credentials in secret variables or Key Vault, and restrict the allowed parameter values.
2. **Partial selection creates drift.** If someone ticks only the cluster after a network change that wasn't applied, the plan fails or, worse, runs on an outdated base. I use `plan` as the default action and a scheduled job that runs `plan` on everything to detect drift.
3. **Execution and destroy order.** On create: `vnet-core`, `aks-core` and `app-orders`. On `destroy` it's the reverse, and the database holds data. So I don't offer `destroy` as an `action` value in `prod`.
4. **Who can click "Run" is part of access control.** The parameter form is an infrastructure control interface: restrict who can run the pipeline and protect the production Environment. And if you attach a `trigger`, remember the automatic run uses the default values (hence `trigger: none` and `default: false`).
5. **Splitting too much.** Twenty small states become twenty dependency points. Split by lifecycle and owner, not by size (Parnas's criterion, again).
6. **A private network also closes your pipeline's door.** If ACR or the state account don't accept public access, the Microsoft-hosted agent can't reach them. Plan the self-hosted agent or runner inside the VNet from the start ([Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/) shows why).

---

## Pros, cons and when I wouldn't use it

**Pros**

- Smaller blast radius and changes that are easier to review.
- Least privilege per stack, per environment and per application.
- Faster plans and no lock contention.
- One pipeline to maintain, with the same code in every instance.
- Modules reused across stacks.
- Names that say what each resource and each state holds.

**Cons**

- More moving parts to understand: modules, stacks, backends, templates.
- Dependencies between stacks become explicit and are your responsibility.
- Migrating from a big state needs planning. The [refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) says to run `terraform plan` on the source configuration and confirm nothing will change.
- Manual selection opens room for human error without guard rails (approvals, allowed values, `plan` as default).

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
- [ ] Approval on the production Environment
- [ ] Saved `plan` applied as an artifact
- [ ] Self-hosted agents or runners inside the VNet, if the network is private
- [ ] Scheduled `plan` job to detect drift
- [ ] Document the dependency order between steps

---

## FAQ

**Why not a single state with `-target`?**
I've seen people try: one state, and a parameter passing `-target=module.aks`. Terraform's [documentation](https://developer.hashicorp.com/terraform/cli/commands/plan) says to use `-target` only in exceptional circumstances (such as recovering from mistakes) and that it isn't recommended for routine operations. It doesn't fix the lock, the refresh time, the blast radius or permission separation. It's the checkbox without half of the design.

**Can I use `object` or `stringList` instead of several booleans in Azure DevOps?**
Yes. `object` lets you iterate with `${{ each }}`, and `stringList` lets you tick several items in a list, but the doc warns it isn't available in templates. The cost is an input that's less friendly than checkboxes and dependencies that are harder to assemble. I haven't tested those variations. For a few steps I prefer booleans, and to run everything at once you just tick them all.

**Does this work with Bicep or OpenTofu?**
The design of parameters, independent stacks and a single pipeline works for any IaC. What's Terraform-specific here is `tfstate` and the backend. OpenTofu uses the same `azurerm` backend model, but confirm the particulars in its documentation.

**How do I migrate from a single state?**
Plan the grouping, move resources with `removed` and `import` blocks (HashiCorp's refactoring guide details it), and confirm `terraform plan` shows no changes in any stack. Start in dev.

---

## Closing

The checkbox in the pipeline is just the visible tip. What holds the idea up is the design underneath: modules that concentrate the *how*, stacks that isolate the *what*, states that isolate the *impact*, names that say what each thing is and identities that isolate the *who*. With that in place, the parameter is just the way you choose.

If you only have one state today, you don't need to split everything at once. Pick the part that hurts most and start there. In [Part 2](/en/blog/en-us/2026-11-22/private-aks-postgresql-terraform-argocd/) I show the architecture behind the examples: AKS and PostgreSQL in a private network, deployed with Argo CD. And if you've done this split another way, I'd like to hear what worked and what didn't in your case.

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
