---
title: "Pipeline parameters: choose what to provision (Terraform, multiple tfstate files and modules)"
description: "How to use YAML parameters in Azure DevOps and GitHub Actions to select which Terraform stacks run, why splitting state matters, and which standards and research back this approach."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modules", "platform-engineering", "azure"]
readingTime: "18 min"
lang: "en"
draft: true
---

> **What you'll find here**
> - How to turn the pipeline into a "panel" where you tick what you want to provision
> - Why this only works well with multiple `tfstate` files and modules, not one giant state
> - The same design in Azure DevOps and GitHub Actions, with YAML
> - Which standards, docs and research this approach rests on (with links)
> - Pros, cons, and the traps I've seen people fall into

---

## The problem that got me here

Every infrastructure team goes through a similar phase. It starts with one Terraform repo, one `main.tf` and a pipeline that runs `terraform apply`. It works great until the file grows: network, database, cluster, Key Vault, monitoring, all in the same state.

Then the symptoms show up, and I've lived all of them:

- You only wanted to add a subnet, but the `plan` takes 12 minutes because it refreshes 600 resources.
- An unexpected cluster diff shows up in the plan of a change that was only about networking.
- Two people need to touch different parts and one waits for the other's lock.
- The pipeline's service principal can do everything, because the state is one and has to see everything.
- A human mistake in one `apply` hits the database along with everything else.

What I use today has two halves that go together:

1. **Design:** infrastructure is split into independent *stacks*, each with its own `tfstate`, built on reusable **modules**.
2. **Execution:** the pipeline receives **parameters** that say *which* stacks to run, in *which* environment, with *which* action.

One half without the other doesn't solve it. Parameters without split state become a checkbox that changes nothing real. Split state without parameters becomes a pile of duplicated pipelines to maintain.

A heads-up: the code in this article is simplified to explain the idea. Adapt names, versions and permissions to your environment and try it in dev first.

---

## The idea in one picture

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="A parameter panel (environment, action and one checkbox per stack) feeds a single pipeline that runs only the ticked stacks. Each stack writes to its own tfstate in the same Azure Storage container; the data stack is unticked and does not run." loading="lazy" />
    <figcaption>Figure 1 — Parameters choose which stacks run. Each stack has its own tfstate, so whatever wasn't selected is neither read nor changed.</figcaption>
</figure>

There is one pipeline. What changes from run to run are the parameters. And since each stack has its own state, "not running" a stack is a safe operation: it simply doesn't take part.

---

## Why this matters

### 1. Smaller blast radius

HashiCorp's [workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) say any operation on a resource can affect other resources managed in the same state, and that you should keep the blast radius small. The guidance is to split by lifecycle (what changes often stays away from what rarely changes), by stateful vs. stateless (databases away from compute) and by team responsibility and permissions. The page even suggests a workspace naming convention, `<business-unit>-<app-name>-<layer>-<env>`, which looks a lot like the `10-network/dev` I use here. It also shows up in the [state refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor).

In practice: a bad `apply` on the application stack doesn't put networking or data in the line of fire.

### 2. Least privilege

With separate states, each stack can run with a different identity holding only the permissions it needs. Networking needs `Network Contributor` at its scope. The data stack needs another set. The pipeline that runs everything as `Owner` on the subscription is no longer necessary.

### 3. Faster feedback

Smaller `plan`, smaller `apply`, smaller lock. The `azurerm` backend locks using native Azure Blob Storage features ([backend docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), and since each stack is a blob with its own `key`, nobody waits for anybody. Microsoft describes this too in its [documentation](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend).

### 4. Small, frequent changes

The Azure Well-Architected Framework, in [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recommends safe deployment practices focused on small, incremental releases with quality gates and progressive exposure. Selecting only what changed is the infrastructure version of that idea. The same page notes that Azure Pipelines and GitHub Actions support multi-stage deployments with approval gates.

### 5. One pipeline to maintain, not ten

Instead of `pipeline-network.yml`, `pipeline-data.yml`, `pipeline-aks.yml` with 90% identical code, there is one stack template and one orchestrator. Fix an authentication issue once, it's fixed everywhere.

---

## Which standards and research this rests on

I didn't invent any of this, and I think it matters to be clear about where it comes from. Here is what I could confirm in the sources, noting where the link is my own analogy and not the author's conclusion.

| Reference | What it says | How it connects |
|---|---|---|
| [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) | Keep the blast radius small; group by volatility, separate stateful from stateless and split by responsibility and privileges. Long-running plans are an early sign of a bloated scope | Grounds the split into multiple `tfstate` files |
| [HashiCorp — Refactor state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) | Plan grouping and dependencies before splitting; sets repeated across configurations are module candidates; migrate with `removed` and `import` blocks (Terraform 1.7+) | Grounds the modules and shows how to migrate from one big state without destroying anything |
| [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy) | Platform landing zone (centralized services) separate from workload landing zones | Same separation logic: what's shared has another lifecycle and another owner |
| [Azure Well-Architected, OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments) | Small, incremental, quality-gated releases; every deployment follows a standard pattern and is automated to reduce human error | One standard pipeline, different parameters |
| [Twelve-Factor App, III. Config](https://12factor.net/config) | Config is what varies between deploys and stays separate from code; the internal wiring between modules, which doesn't vary, belongs in code | Environment and stack selection are *config*; the module calls inside each stack are code |
| [Parnas (1972), *On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) | According to the paper's own abstract, the effectiveness of a modularization depends on the criteria used to divide the system into modules | Classic basis for "split by the right criterion". It's an analogy: the paper is about software, not IaC |
| [Rahman, Parnin and Williams (ICSE 2019), *The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) | Analyzed 15,232 IaC scripts and found 21,201 security smell occurrences, 1,326 of them hard-coded passwords | Reason to treat parameters as selection and never as a place for secrets |
| [DORA — delivery metrics](https://dora.dev/guides/dora-metrics/) | Five metrics: change lead time, deployment frequency, failed deployment recovery time, change fail rate and deployment rework rate. The research states that speed and stability are not tradeoffs | These are the metrics where I expect gains from small, isolated changes (my argument, not a research finding) |

A caution on DORA: I'm not saying "pipeline parameters" appear as a research finding. The argument that smaller, more isolated changes help those metrics is mine, and it rests on two points. The [Deployment automation](https://dora.dev/capabilities/deployment-automation/) capability describes automated delivery with scripts and environment-specific configuration kept in version control. And the [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) capability states that in tightly coupled architectures small changes can cause cascading failures; it is about software architecture and teams, so the link to IaC is an analogy. The [2024 report](https://dora.dev/research/2024/dora-report/) also reinforces that fundamentals like small batch sizes and robust testing remain crucial.

---

## The example: Terraform with multiple tfstate files and modules

### Repository layout

```text
infra/
├── modules/                  # peças reutilizáveis, sem state próprio
│   ├── network/
│   ├── data/
│   └── aks/
├── stacks/                   # cada pasta é uma raiz Terraform = um tfstate
│   ├── 10-network/
│   ├── 20-data/
│   └── 30-aks/
├── envs/
│   ├── dev.tfvars
│   ├── hml.tfvars
│   └── prd.tfvars
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/terraform-stack.yml
```

The rule I follow:

- A **module** is the *how*: a reusable recipe for network, AKS, database. No backend, no state.
- A **stack** is the *what and where*: a Terraform root that calls modules, has its own backend and is what the pipeline executes.
- An **environment** is just data: a `.tfvars` and a different `key` in the backend.

The numeric prefix (`10-`, `20-`, `30-`) is only a convention to make dependency order visible.

### The backend: one key per stack and per environment

Each stack declares an empty backend and receives the rest at `init` time (what Terraform calls *partial configuration*):

```hcl
# infra/stacks/30-aks/main.tf
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

And `init` sets the `key`, which in `azurerm` is the blob name inside the container:

```bash
terraform init -input=false \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=sttfstatecorp001" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=30-aks/dev.tfstate"
```

In the end, the container looks like this:

```text
tfstate/
├── 10-network/dev.tfstate
├── 10-network/prd.tfstate
├── 20-data/dev.tfstate
├── 20-data/prd.tfstate
├── 30-aks/dev.tfstate
└── 30-aks/prd.tfstate
```

Two things deserve attention. The state account should live outside what Terraform manages in the stacks, and authentication should use Microsoft Entra ID rather than access keys (the [docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) mark the access key as "not recommended for new workloads" and list `Storage Blob Data Contributor` on the container as the least-privilege option).

### A module called by the stack

```hcl
# infra/stacks/30-aks/main.tf (continued)
variable "environment" { type = string }
variable "workload"    { type = string }

data "azurerm_subnet" "aks" {
  name                 = "snet-aks-${var.environment}"
  virtual_network_name = "vnet-${var.workload}-${var.environment}"
  resource_group_name  = "rg-network-${var.workload}-${var.environment}"
}

module "aks" {
  source = "../../modules/aks"

  environment = var.environment
  workload    = var.workload
  subnet_id   = data.azurerm_subnet.aks.id
}
```

Notice the AKS stack **does not read the network stack's state**. It looks up the network through the Azure API with a `data source`. That's a conscious decision, and I come back to it below.

If modules live in another repository, `source` points to a tag so the version is pinned: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## Azure DevOps: runtime parameters

Azure Pipelines has [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): you declare a parameter with a type, a default and, optionally, a list of allowed values, and the **Run pipeline** screen builds the form for you. Three types cover what we want: `string` with `values` (becomes a dropdown), `boolean` (becomes a checkbox) and `object` (for richer structures). There is also `stringList`, which lets you tick several items, but the documentation warns it isn't available in templates (use `object` there). I show that variation just below.

### The orchestrator

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # always an intentional run; see "Traps" below

parameters:
  - name: environment
    displayName: Environment
    type: string
    default: dev
    values: [dev, hml, prd]

  - name: action
    displayName: Action
    type: string
    default: plan
    values: [plan, apply]

  - name: network
    displayName: "10 · Network"
    type: boolean
    default: false

  - name: data
    displayName: "20 · Data"
    type: boolean
    default: false

  - name: aks
    displayName: "30 · AKS"
    type: boolean
    default: false

stages:
  - ${{ if eq(parameters.network, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: 10-network
          stageName: network
          environment: ${{ parameters.environment }}
          action: ${{ parameters.action }}

  - ${{ if eq(parameters.data, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: 20-data
          stageName: data
          environment: ${{ parameters.environment }}
          action: ${{ parameters.action }}
          ${{ if eq(parameters.network, true) }}:
            dependsOn: [network]

  - ${{ if eq(parameters.aks, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: 30-aks
          stageName: aks
          environment: ${{ parameters.environment }}
          action: ${{ parameters.action }}
          ${{ if eq(parameters.network, true) }}:
            dependsOn: [network]
```

The key is the `${{ if ... }}` expressions. They are **template expressions**, evaluated when the pipeline is assembled (the [template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) docs explain they are resolved at initialization). That means the stage of an unticked stack **doesn't exist** in the run. It doesn't show up as "skipped", it doesn't use an agent, it just isn't there.

The conditional `dependsOn` solves an annoying detail: if you declare a dependency on a stage that wasn't included, pipeline validation fails. Here the dependency only exists when the network stack was also selected.

### Variation: a multi-select list

Instead of one boolean per stack, you can use a `stringList` in the main pipeline, where the run screen lets you tick several items at once:

```yaml
parameters:
  - name: stacks
    displayName: Stacks to provision
    type: stringList
    values: [network, data, aks]
    default: [network]

stages:
  - ${{ each stack in parameters.stacks }}:
      - ${{ if eq(stack, 'network') }}:
          - template: templates/terraform-stack.yml
            parameters:
              stack: 10-network
              stageName: network
              environment: ${{ parameters.environment }}
              action: ${{ parameters.action }}
```

The documentation shows this iteration with `each` over a `stringList`. I avoided `contains` because, per the [expressions reference](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions), it compares strings; for arrays there is `containsValue`, but the page itself describes it as of limited use outside pipeline decorators. I haven't run this example, so validate it before adopting. With this form, the conditional `dependsOn` from the main example tends to get more cumbersome.

### The stack template

```yaml
# infra/pipelines/templates/terraform-stack.yml
parameters:
  - name: stack
    type: string
  - name: stageName
    type: string
  - name: environment
    type: string
  - name: action
    type: string
  - name: dependsOn
    type: object
    default: []

stages:
  - stage: ${{ parameters.stageName }}
    displayName: "${{ parameters.stack }} (${{ parameters.environment }})"
    dependsOn: ${{ parameters.dependsOn }}
    jobs:
      - job: plan
        pool:
          vmImage: ubuntu-latest
        steps:
          - task: AzureCLI@2
            displayName: terraform init + plan
            inputs:
              azureSubscription: sc-terraform-${{ parameters.environment }}
              scriptType: bash
              scriptLocation: scriptPath
              scriptPath: infra/scripts/tf.sh
              arguments: plan ${{ parameters.stack }} ${{ parameters.environment }}
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
              vmImage: ubuntu-latest
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
                        arguments: apply ${{ parameters.stack }} ${{ parameters.environment }}
                        addSpnToEnvironment: true
                      env:
                        SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                        SYSTEM_OIDCREQUESTURI: $(System.OidcRequestUri)
```

What's going on:

- One **service connection per environment** (`sc-terraform-dev`, `sc-terraform-prd`), ideally with identity federation. No stored secret.
- The `deployment` job uses an Azure DevOps **Environment**. That's where you configure approvals and checks for `prd`. Who approves the production `apply` is an Environment decision, not a YAML one. According to the [documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), approvals and checks aren't defined in the YAML and whoever edits the YAML can't change them; the resource administrators (Environment, service connection, etc.) manage them through the web interface.
- The `plan` is published as an artifact and `apply` applies **that** plan. What was reviewed is what gets applied, not a new plan computed after approval.

### The script both steps use

```bash
#!/usr/bin/env bash
# infra/scripts/tf.sh  ->  tf.sh <plan|apply> <stack> <env>
set -euo pipefail

cmd="$1"; stack="$2"; env="$3"
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
  -backend-config="key=${stack}/${env}.tfstate"

case "$cmd" in
  plan)
    terraform plan -input=false \
      -var="environment=${env}" -var-file="../../envs/${env}.tfvars" \
      -out="${plan_file}"
    ;;
  apply)
    terraform apply -input=false \
      "${PIPELINE_WORKSPACE}/plan-${stack#*-}/${stack}.tfplan"
    ;;
esac
```

`TFSTATE_RG` and `TFSTATE_SA` can come from pipeline variables. The [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) task exposes `$servicePrincipalId` and `$tenantId` (and the `idToken`) in the script environment when `addSpnToEnvironment: true` and the service connection uses identity federation. For the backend, the [`azurerm` documentation](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) says that on Azure DevOps the OIDC token endpoints are found automatically and that, with `AzureCLI@2` or `AzurePowerShell`, the service connection ID is already available in the `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` variable. That's why the script doesn't pass the token manually. For the *provider*, the [`azurerm` OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) says that on Azure DevOps it uses `ARM_OIDC_REQUEST_TOKEN` and `ARM_OIDC_REQUEST_URL` or, when absent, falls back to `SYSTEM_ACCESSTOKEN` and `SYSTEM_OIDCREQUESTURI`, and requires the service connection ID in `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. That's why the tasks' `env:` passes `System.AccessToken` and `System.OidcRequestUri`, and why the script reuses `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` (that reuse is mine: the guide uses its own variable holding the connection ID). The guide also recommends `AzureCLI@2` over `TerraformTaskV4`, which depends on an extension that isn't installed by default, and states that OIDC support in the provider starts at version 3.7.0.

---

## GitHub Actions: the same design

On GitHub, the equivalent of parameters is `workflow_dispatch` with `inputs`. Supported types are `string`, `choice`, `boolean` and `environment` (plus `number`), as the [input types changelog](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows) describes. `environment` is interesting: it lists the repository's Environments as options. One limit to know: since December 2025 `workflow_dispatch` accepts [up to 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/); it used to be 10.

### The orchestrator

```yaml
# .github/workflows/infra.yml
name: infra

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Environment
        type: environment
        required: true
      action:
        description: Action
        type: choice
        options: [plan, apply]
        default: plan
      network:
        description: "10 · Network"
        type: boolean
        default: false
      data:
        description: "20 · Data"
        type: boolean
        default: false
      aks:
        description: "30 · AKS"
        type: boolean
        default: false

permissions:
  id-token: write
  contents: read

jobs:
  network:
    if: ${{ inputs.network }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: 10-network
      environment: ${{ inputs.environment }}
      action: ${{ inputs.action }}

  data:
    needs: [network]
    if: ${{ !cancelled() && !failure() && inputs.data }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: 20-data
      environment: ${{ inputs.environment }}
      action: ${{ inputs.action }}

  aks:
    needs: [network]
    if: ${{ !cancelled() && !failure() && inputs.aks }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: 30-aks
      environment: ${{ inputs.environment }}
      action: ${{ inputs.action }}
```

There is an important difference from Azure DevOps here. On GitHub the condition is evaluated **at runtime**, so an unticked job shows up as *skipped*. And, according to the [documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), if a job fails or is skipped, all jobs that need it are skipped too, unless they use a conditional expression that lets them continue. `!cancelled() && !failure()` fixes that: "run if nothing failed, even if the dependency was skipped". One more detail: the `inputs` context preserves booleans, while `github.event.inputs` converts everything to strings; that's why I use `inputs.network` directly in the `if`.

### The reusable workflow

```yaml
# .github/workflows/terraform-stack.yml
name: terraform-stack

on:
  workflow_call:
    inputs:
      stack:       { type: string, required: true }
      environment: { type: string, required: true }
      action:      { type: string, required: true }

permissions:
  id-token: write
  contents: read

jobs:
  terraform:
    runs-on: ubuntu-latest
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
            -backend-config="key=${{ inputs.stack }}/${{ inputs.environment }}.tfstate"

      - name: plan
        run: |
          terraform plan -input=false -out=tfplan \
            -var="environment=${{ inputs.environment }}" \
            -var-file="../../envs/${{ inputs.environment }}.tfvars"

      - name: apply
        if: ${{ inputs.action == 'apply' }}
        run: terraform apply -input=false tfplan
```

The points that make a difference:

- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) are called at the job level, receive `inputs` through `with`, and the type must match what was declared (boolean, number or string). The documentation allows chaining up to ten levels of workflows (the caller plus nine). One detail that fits our design: the job that calls the reusable workflow can't use `environment`; the `environment` is declared by the job inside the reusable workflow, as we did.
- Authentication is via **OIDC**. `ARM_USE_OIDC` makes the provider request the token from GitHub and exchange it for Azure access, with no stored secret. [GitHub's documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) shows the flow using the `azure/login` action. Here I let Terraform itself do the exchange: per the [provider OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc), on GitHub Actions it detects `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` on its own, as long as the workflow has `id-token: write`. The same guide notes the federated credential is per Environment, branch, pull request or tag, and the values must match exactly. If you prefer the more beaten path, log in with `azure/login` first.
- When the job uses an Environment, the token *subject* has the format `repo:ORG/REPO:environment:NAME`. That lets you create **one federated credential per environment** in Entra ID: `prd` only accepts tokens from jobs in the `prd` Environment. Least privilege and per-environment separation almost for free. Mind a recent change: per [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc), repositories created after July 15, 2026 (and renamed or transferred after that date) use an immutable subject by default, which includes the owner and repository IDs, while older ones keep the name-based format until you opt in. [Microsoft recommends migrating](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) name-based credentials. In other words, the federated credential must match your repository's format. The reference shows the environment subject example (`repo:octo-org/octo-repo:environment:Production`) and, for the immutable format, the branch example (`repo:octo-org@123456/octo-repo@456789:ref:refs/heads/main`), so confirm what the environment subject looks like in your case. The documentation also recommends protecting the Environment with rules (for example, restricting branches and tags) when it is used in OIDC policies.
- In this example, `plan` and `apply` run in the same job, applying the saved plan. The cost is that if the Environment has *required reviewers*, approval is requested **before** the plan. If that bothers you, use two Environments (`dev-plan` and `dev-apply`, for example) or split into two jobs.

---

## Comparing the two

| Point | Azure DevOps | GitHub Actions |
|---|---|---|
| Run parameter | `parameters` with `type` and `values` | `workflow_dispatch.inputs` (`choice`, `boolean`, `environment`, `string`) |
| When selection applies | Pipeline assembly: the stage doesn't exist | Execution: the job shows as skipped |
| Approval | Environment with approvals and checks | Environment with required reviewers |
| Reuse | Templates (`template:`) | Reusable workflows (`workflow_call`) |
| Authentication | Service connection with federation | OIDC with a federated credential per Environment |
| Limit that bit me | Parameters need a `default`; trigger-started runs use the defaults | 25 inputs per `workflow_dispatch`; up to 10 chained workflow levels |

Neither is better at everything. The "missing stage vs. skipped job" difference looks small, but it changes how you read run history and how you set up dependencies.

---

## Why not a single state with `-target`?

I've seen people try the opposite path: one state, and a parameter passing `-target=module.aks`. I don't recommend it as routine. Terraform's own [documentation](https://developer.hashicorp.com/terraform/cli/commands/plan) says to use `-target` only in exceptional circumstances (such as recovering from mistakes) and that it isn't recommended for routine operations. It doesn't fix the lock, the refresh time, the blast radius in the state or permission separation. It's the checkbox without half of the design.

---

## Between stacks: `terraform_remote_state` or a data source?

When one stack depends on another, there are two ways to read the information:

- `terraform_remote_state`: reads the other stack's state outputs. Direct, but the reader needs access to the entire state file (which may hold sensitive data) and you couple one stack to the other's state layout.
- **Provider data source**: queries the real resource through the Azure API. It requires a naming convention, but gives looser coupling and doesn't need access to someone else's state.

HashiCorp doesn't forbid sharing outputs: in its workspace best practices it recommends exposing only the outputs other workspaces need (through `tfe_outputs`), precisely to reduce the risk of leaking sensitive information from the state. I prefer the data source by default and use `remote_state` when I need an output that doesn't exist as a queryable resource. That preference is mine, based on experience, not a HashiCorp rule, so evaluate it in your context.

---

## Traps I've seen

1. **A parameter is not a vault.** Microsoft warns that parameter values are expanded when the template is parsed and may show up in logs. Secrets don't go in parameters. The ICSE 2019 study cited above found that a hard-coded secret can persist for up to 98 months (median 20), so don't count on "we'll remove it later". The Azure DevOps documentation also says to validate and restrict allowed parameter values, apply least privilege and keep credentials in secret variables, Key Vault or variable groups.
2. **Partial selection creates drift.** If someone ticks only the AKS stack after a network change that wasn't applied, the plan will fail or, worse, be applied on top of an outdated base. I handle it with `plan` as the default action and a scheduled job that runs `plan` on everything to detect drift.
3. **Destroy order.** On create, network comes before cluster. On `destroy` it's the reverse. So I simply don't offer `destroy` as an `action` value in `prd`.
4. **Who can click "Run" is part of access control.** The parameter form is an infrastructure control interface. Restrict who can run the pipeline and protect the production Environment.
5. **Splitting too much.** Twenty small states become twenty dependency points. Split by lifecycle and owner, not by size.
6. **Trigger runs use defaults.** If you attach the pipeline to a `trigger`, the automatic run uses the parameters' default values. Hence `trigger: none` in the example and `default: false` on the stacks.

---

## Pros and cons

**Pros**

- Smaller blast radius and changes that are easier to review.
- Least privilege per stack and per environment.
- Faster plans and no lock contention.
- One pipeline to maintain, with the same code in every environment.
- Clear history: the run records what was selected.

**Cons**

- More moving parts to understand: modules, stacks, backends, templates.
- Dependencies between stacks become explicit and you have to manage them.
- Migrating from a big state needs planning (HashiCorp's [refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) says to run `terraform plan` on the source configuration and confirm it won't change anything).
- Manual selection opens room for human error unless you add guard rails (approvals, allowed values, `plan` as default).
- A wrong split trades one problem for another: coupling between states.

---

## Checklist to get started

- [ ] Map resources by lifecycle, owner and stateful/stateless before splitting
- [ ] Extract modules for what repeats
- [ ] One stack per Terraform root, with an empty `backend "azurerm" {}`
- [ ] `key` = `<stack>/<environment>.tfstate`
- [ ] Authentication through identity federation, no secrets
- [ ] Parameters: `environment` with a closed list, `action` defaulting to `plan`, one boolean per stack
- [ ] Approval on the production Environment
- [ ] Saved `plan` applied as an artifact
- [ ] Scheduled `plan` job to detect drift
- [ ] Document the dependency order between stacks

---

## FAQ

**Can I use `object` instead of several booleans in Azure DevOps?**
Yes, and you can iterate with `${{ each }}`, which shortens the YAML. The cost is that the input is less friendly than checkboxes and easier to get wrong. For a middle ground, see the `stringList` variation above. For a few stacks I prefer booleans.

**What if I want to run every stack at once?**
Tick them all. If that's the most common case, consider an `all` parameter or an execution profile, but keep individual selection available.

**Does this work with Bicep or OpenTofu?**
The design of parameters, independent stacks and a single pipeline works for any IaC. What's Terraform-specific here is `tfstate` and the backend. OpenTofu uses the same `azurerm` backend model; confirm the particulars in its documentation.

**How do I migrate from a single state?**
Plan the grouping, move resources with `removed` and `import` blocks (HashiCorp's refactoring guide details it), and confirm `terraform plan` shows no changes in any stack. Do it in dev first.

**Do I need Terraform Cloud for this?**
No. What I showed uses the `azurerm` backend and the pipeline. Terraform Cloud has the workspace concept, which solves part of this differently.

---

## Closing

What convinced me most was realizing the checkbox in the pipeline is just the visible tip. What holds the idea up is the design underneath: modules that concentrate the *how*, stacks that isolate the *what*, states that isolate the *impact* and identities that isolate the *who*. With that in place, the parameter is just the way you choose.

If you only have one state today, you don't need to split everything at once. Start with what changes most often or what would hurt most to break, usually network and data, and go from there.

---

## References

**Official documentation**
- [Azure Pipelines — Runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters)
- [Azure Pipelines — Template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)
- [Azure Pipelines — Template parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-parameters)
- [Azure Pipelines — Approvals and checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
- [Azure Pipelines — AzureCLI@2 task](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2)
- [GitHub — Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub — OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [Terraform azurerm — OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch now supports 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — OIDC in Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — GitHub immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — terraform plan and `-target`](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [HashiCorp — azurerm backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)

**Standards and good practices**
- [Azure Well-Architected — Safe deployment practices (OE:11)](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments)
- [Azure Landing Zones — Deploy](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy)
- [Azure Landing Zones — Terraform design considerations](https://learn.microsoft.com/azure/architecture/landing-zones/terraform/landing-zone-terraform)
- [The Twelve-Factor App — III. Config](https://12factor.net/config)

**Research**
- D. L. Parnas, [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623), Communications of the ACM, 15(12), 1972.
- A. Rahman, C. Parnin, L. Williams, [*The Seven Sins: Security Smells in Infrastructure as Code Scripts*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts), ICSE 2019.
- [DORA — Software delivery performance metrics](https://dora.dev/guides/dora-metrics/)
- [DORA — Deployment automation](https://dora.dev/capabilities/deployment-automation/)
- [DORA — Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/)
- [Accelerate State of DevOps 2024 (DORA)](https://dora.dev/research/2024/dora-report/)
