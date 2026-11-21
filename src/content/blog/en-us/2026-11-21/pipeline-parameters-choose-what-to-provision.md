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

HashiCorp's [workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) say any operation on a resource can affect other resources managed in the same state, and that you should keep the blast radius small. The guidance is to split by lifecycle (what changes often stays away from what rarely changes), by stateful vs. stateless (databases away from compute) and by team responsibility and permissions. It also shows up in the [state refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor).

In practice: a bad `apply` on the application stack doesn't put networking or data in the line of fire.

### 2. Least privilege

With separate states, each stack can run with a different identity holding only the permissions it needs. Networking needs `Network Contributor` at its scope. The data stack needs another set. The pipeline that runs everything as `Owner` on the subscription is no longer necessary.

### 3. Faster feedback

Smaller `plan`, smaller `apply`, smaller lock. The `azurerm` backend locks using native Azure Blob Storage features ([backend docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), and since each stack is a blob with its own `key`, nobody waits for anybody. Microsoft describes this too in its [documentation](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend).

### 4. Small, frequent changes

The Azure Well-Architected Framework, in [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recommends safe deployment practices focused on small, incremental releases with quality gates and progressive exposure. Selecting only what changed is the infrastructure version of that idea.

### 5. One pipeline to maintain, not ten

Instead of `pipeline-network.yml`, `pipeline-data.yml`, `pipeline-aks.yml` with 90% identical code, there is one stack template and one orchestrator. Fix an authentication issue once, it's fixed everywhere.

---

## Which standards and research this rests on

I didn't invent any of this, and I think it matters to be clear about where it comes from. Here is what I could confirm in the sources, noting where the link is my own analogy and not the author's conclusion.

| Reference | What it says | How it connects |
|---|---|---|
| [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) | Keep the blast radius small; split by lifecycle, stateful/stateless and responsibility | Grounds the split into multiple `tfstate` files |
| [HashiCorp — Refactor state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) | Plan grouping and dependencies before splitting; use `removed` and `import` blocks | Shows how to migrate from one big state without destroying anything |
| [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy) | Platform landing zone separate from application landing zones, per environment | Same logic: what's shared changes less and has a different owner |
| [Azure Well-Architected, OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments) | Small, incremental deployments through pipelines, same artifacts across environments | One pipeline, different parameters |
| [Twelve-Factor App, III. Config](https://12factor.net/config) | Config is what varies between deploys and stays separate from code | Environment and stack selection are *config*; the module code is the same |
| [Parnas (1972), *On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) | The effectiveness of a modularization depends on the criteria used to split the system | Classic basis for "split by the right criterion". It's an analogy: the paper is about software, not IaC |
| [Rahman, Parnin and Williams (ICSE 2019), *The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) | Analyzed 15,232 IaC scripts and found 21,201 security smell occurrences, 1,326 of them hard-coded passwords | Reason to treat parameters as selection and never as a place for secrets |
| [State of DevOps 2021 (DORA)](https://cloud.google.com/resources/state-of-devops) | Measures delivery by lead time, deployment frequency, time to restore and change failure rate | These are the metrics that improve when changes get small and isolated |

A caution on DORA: I'm not saying "pipeline parameters" appear as a research finding. The research measures those four metrics, and the argument is that smaller, more isolated changes help exactly there. For the foundation, the book *Accelerate* (Forsgren, Humble and Kim) groups the continuous delivery capabilities.

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

Two things deserve attention. The state account should live outside what Terraform manages in the stacks, and authentication should use Microsoft Entra ID rather than access keys (the [docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) treat Entra ID as the recommended option, requiring `Storage Blob Data Contributor` on the container).

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

Azure Pipelines has [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): you declare a parameter with a type, a default and, optionally, a list of allowed values, and the **Run pipeline** screen builds the form for you. Three types cover what we want: `string` with `values` (becomes a dropdown), `boolean` (becomes a checkbox) and `object` (for richer structures).

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
```

What's going on:

- One **service connection per environment** (`sc-terraform-dev`, `sc-terraform-prd`), ideally with identity federation. No stored secret.
- The `deployment` job uses an Azure DevOps **Environment**. That's where you configure approvals and checks for `prd`. Who approves the production `apply` is an Environment decision, not a YAML one.
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
export ARM_CLIENT_ID="$servicePrincipalId"
export ARM_TENANT_ID="$tenantId"
export ARM_OIDC_TOKEN="$idToken"
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

`TFSTATE_RG` and `TFSTATE_SA` can come from pipeline variables. `$servicePrincipalId`, `$tenantId` and `$idToken` are exposed by the `AzureCLI@2` task when `addSpnToEnvironment: true` and the service connection uses federation. Confirm that behavior on the task version you use, since Microsoft keeps changing this area.

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

There is an important difference from Azure DevOps here. On GitHub the condition is evaluated **at runtime**, so an unticked job shows up as *skipped*. And when a `needs` is skipped, the dependent job would also be skipped by default. `!cancelled() && !failure()` fixes that: "run if nothing failed, even if the dependency was skipped".

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

- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) are called at the job level, receive `inputs` through `with`, and the type must match what was declared. There is a limit of 20 reusable workflow calls per file, nested ones included.
- Authentication is via **OIDC**. `ARM_USE_OIDC` makes the provider request the token from GitHub and exchange it for Azure access, with no stored secret. [GitHub's documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) shows the flow.
- When the job uses an Environment, the token *subject* has the format `repo:ORG/REPO:environment:NAME`. That lets you create **one federated credential per environment** in Entra ID: `prd` only accepts tokens from jobs in the `prd` Environment. Least privilege and per-environment separation almost for free. GitHub has also started offering an immutable subject (with owner and repository IDs) for new repositories, and [Microsoft recommends migrating](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) name-based credentials; check how it affects your repo.
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
| Limit that bit me | Parameters don't apply to trigger-started runs (defaults are used) | 25 inputs per `workflow_dispatch`; 20 reusable workflow calls |

Neither is better at everything. The "missing stage vs. skipped job" difference looks small, but it changes how you read run history and how you set up dependencies.

---

## Why not a single state with `-target`?

I've seen people try the opposite path: one state, and a parameter passing `-target=module.aks`. I don't recommend it as routine. Terraform's own documentation treats `-target` as a tool for exceptional situations, not a normal workflow. It doesn't fix the lock, the refresh time, the blast radius in the state or permission separation. It's the checkbox without half of the design.

---

## Between stacks: `terraform_remote_state` or a data source?

When one stack depends on another, there are two ways to read the information:

- `terraform_remote_state`: reads the other stack's state outputs. Direct, but the reader needs access to the entire state file (which may hold sensitive data) and you couple one stack to the other's state layout.
- **Provider data source**: queries the real resource through the Azure API. It requires a naming convention, but gives looser coupling and doesn't need access to someone else's state.

I prefer the data source by default and use `remote_state` when I need an output that doesn't exist as a queryable resource. That preference is mine, based on experience, not a HashiCorp rule, so evaluate it in your context.

---

## Traps I've seen

1. **A parameter is not a vault.** Microsoft warns that parameter values are expanded when the template is parsed and may show up in logs. Secrets don't go in parameters. The ICSE 2019 study cited above is a good reminder of how common hard-coded passwords in IaC are.
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
- Migrating from a big state needs planning (HashiCorp's [state splitting guide](https://support.hashicorp.com/hc/en-us/articles/7955227415059-How-to-Split-State-Files) recommends validating that the post-split `plan` shows no changes).
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
Yes, and you can iterate with `${{ each }}`, which shortens the YAML. The cost is that the form becomes a YAML text field instead of checkboxes, so it's easier to get wrong. For a few stacks I prefer booleans.

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
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch now supports 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — OIDC in Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — GitHub immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — How to split state files](https://support.hashicorp.com/hc/en-us/articles/7955227415059-How-to-Split-State-Files)
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
- [Accelerate State of DevOps 2021 (DORA)](https://cloud.google.com/resources/state-of-devops)
- N. Forsgren, J. Humble, G. Kim, *Accelerate*, IT Revolution, 2018.
