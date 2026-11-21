---
title: "Pipeline parameters: choose what to provision (Terraform, multiple tfstate files and modules)"
description: "How to use YAML parameters in Azure DevOps and GitHub Actions to select which Terraform stacks run, why splitting state matters, and how it looks on a reference architecture with AKS and PostgreSQL in a private network, deployed with GitOps (Argo CD)."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modules", "aks", "argocd", "gitops", "postgresql", "private-link", "platform-engineering", "azure"]
readingTime: "26 min"
lang: "en"
draft: true
---

> **TL;DR**
> - Split infrastructure into independent *stacks*, each with its own `tfstate` and built on modules, and make the pipeline take parameters that say **what to run**, **where** and **with which action**.
> - The gain: smaller blast radius, least privilege per stack, faster `plan` and a single pipeline to maintain.
> - In the reference architecture (AKS and PostgreSQL in a private network), Terraform delivers the network, the cluster and the application's dedicated database. The application itself goes into the cluster through **Argo CD** (GitOps), from manifests in a dedicated directory, `infra/argocd`. The pipeline only installs Argo CD, once per cluster.
> - The same design works in Azure DevOps (`parameters`) and GitHub Actions (`workflow_dispatch` + `inputs`).
> - Every argument comes with its source (HashiCorp, Microsoft, DORA and others). Where the link is my own analogy, the text says so.
> - The cost: more moving parts, and dependencies between stacks that become your responsibility.

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
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="A parameter panel (environment, instance, action and one checkbox per step) feeds a single pipeline that runs only the ticked steps: the vnet-prod-brs-01 and aks-prod-brs-01 stacks. The orders application stack and the Argo CD bootstrap are unticked and do not run. Each stack writes to its own tfstate, named after the resource, in the same Azure Storage container." loading="lazy" />
    <figcaption>Figure 1 — Parameters choose what runs. Each stack has its own tfstate, so whatever wasn't selected is neither read nor changed.</figcaption>
</figure>

There is one pipeline. What changes from run to run are the parameters. And since each stack has its own state, "not running" a stack is a safe operation: it simply doesn't take part.

---

## Why this matters

I didn't invent any of this, so every argument below comes with its source. Where the link to the source is my own analogy and not the author's conclusion, I say so.

### 1. Smaller blast radius

HashiCorp's [workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) say any operation on a resource can affect other resources managed in the same state, and that you should keep the blast radius small. The guidance is to group by volatility (what changes often stays away from what rarely changes), separate stateful from stateless (databases away from compute) and split by team responsibility and privileges. The page even suggests a workspace naming convention, `<business-unit>-<app-name>-<layer>-<env>`, which is a relative of the pattern I use here (`type-environment-region-seq`). It also warns that long-running plans and applies are an early sign of a bloated scope.

The [state refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) points the same way: resources with different update cadences should be managed separately to reduce the blast radius of unintended changes.

In practice: a bad `apply` on the cluster stack doesn't put networking or the database in the line of fire.

### 2. Least privilege

With separate states, each stack can run with a different identity holding only the permissions it needs. Networking needs `Network Contributor` at its scope. The application stack needs another set. The pipeline that runs everything as `Owner` on the subscription is no longer necessary.

HashiCorp states this as an explicit recommendation: split workspaces by team responsibility and privileges, because if the scope is too large someone ends up needing more permission than appropriate. The same logic appears in the [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy): the platform landing zone, with centralized services, is separate from the workload landing zones. What's shared has another lifecycle and another owner. The link to Terraform stacks is my own analogy, but the separation logic is the same.

### 3. Faster feedback

Smaller `plan`, smaller `apply`, smaller lock. The `azurerm` backend locks using native Azure Blob Storage features ([backend docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), and since each stack is a blob with its own `key`, nobody waits for anybody. [Microsoft's documentation](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend) describes the same behavior.

### 4. Small, frequent changes

The Azure Well-Architected Framework, in [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recommends safe deployment practices focused on small, incremental releases with quality gates and progressive exposure. It also says every deployment should follow a standard pattern and be automated to reduce human error. The same page notes that Azure Pipelines and GitHub Actions support multi-stage deployments with approval gates. Selecting only what changed is the infrastructure version of that idea.

This is where DORA comes in, with a caution: I'm not saying "pipeline parameters" appear as a research finding. DORA now measures [five delivery metrics](https://dora.dev/guides/dora-metrics/) (change lead time, deployment frequency, failed deployment recovery time, change fail rate and deployment rework rate) and states that speed and stability are not tradeoffs. The argument that smaller, more isolated changes help those metrics is mine, and it rests on what the [2024 report](https://dora.dev/research/2024/dora-report/) reinforces: fundamentals like small batch sizes and robust testing remain crucial.

### 5. One pipeline to maintain, not ten

Instead of `pipeline-vnet.yml`, `pipeline-aks.yml`, `pipeline-app.yml` with 90% identical code, there is one stack template and one orchestrator. Fix an authentication issue once, it's fixed everywhere.

DORA's [Deployment automation](https://dora.dev/capabilities/deployment-automation/) capability describes exactly this shape: an automated deployment process that takes the packages, the scripts and the environment-specific configuration, with scripts and configuration kept in version control. And the [Twelve-Factor App](https://12factor.net/config) gives the criterion for separating what varies from what doesn't: config is what changes between deploys (staging, production, development) and stays separate from code, while the application's internal wiring, which doesn't vary, belongs in code. In our case, environment and instance are config. The module calls inside each stack are code.

---

## The example: a reference architecture in a private network

To keep the example from being abstract, I picked an architecture I run into often: an application on **AKS** with a **PostgreSQL** database dedicated to it, everything in a private network. The icons are the official Microsoft ones ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), used according to the terms: no change to their shape and with the product name next to the icon).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Reference architecture in a private network: corporate network users enter through an internal ingress into the aks-prod-brs-01 cluster, inside the snet-aks subnet, where the orders pod runs. The pod reaches the dedicated PostgreSQL pgsql-orders-prod-brs-01, in the delegated snet-postgres subnet, and, through Private Endpoints in snet-endpoints, the Key Vault. The cluster pulls images from the Container Registry through another Private Endpoint. Self-hosted agents in snet-agents run Terraform and the Argo CD bootstrap. Argo CD, inside the cluster, syncs the manifests from a Git repository to the pod. Private DNS zones linked to the VNet resolve the names. Each resource is tagged with the Terraform stack that owns it: vnet-prod-brs-01, aks-prod-brs-01 or app-orders-prod-brs-01." loading="lazy" />
    <figcaption>Figure 2 — Reference architecture. The pills show the Terraform stack that owns each resource. The pod enters the cluster through Argo CD, from Git, outside Terraform. The editable source is in draw.io.</figcaption>
</figure>

What the figure shows, and the documentation behind each decision:

- **AKS as a private cluster.** With `private_cluster_enabled`, the API server gets an internal IP and talks to the nodes through Azure Private Link, as the [AKS private clusters documentation](https://learn.microsoft.com/en-us/azure/aks/private-clusters) describes.
- **PostgreSQL with network integration (private access).** The server sits in a **delegated** subnet that only it can use, at least `/28`, and needs a Private DNS zone whose name ends in `postgres.database.azure.com`. The [PostgreSQL networking documentation](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) also says that, when creating through Terraform, you must create those zones yourself, and that the zone name can't be the same as the server's.
- **Container Registry and Key Vault through Private Endpoints.** For ACR, private link requires the **Premium** SKU ([ACR docs](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). For Key Vault, the [Private Link docs](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service) describe the same mechanism. The DNS zone and subresource names (`registry` and `vault`) are in the [private endpoint DNS zone table](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Self-hosted agents inside the VNet.** The pipeline has to reach private things: the cluster API (for the Argo CD bootstrap) and, if you close public access, the registry and the state account. The ACR docs warn that once public network access is disabled, instances of some Azure services, including Azure DevOps Services, can't reach it. And the [private cluster access](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) docs say `az aks command invoke` is not for programmatic access: for automated calls, they point to Bastion, VPN or ExpressRoute. That's why `snet-agents` appears in the figure, dashed: the agents themselves live outside this example's stacks.
- **Argo CD inside the cluster, pulling from Git.** [Argo CD](https://argo-cd.readthedocs.io/en/stable/) is a Kubernetes controller that continuously compares the live state with the desired state, defined in the Git repository. Since it runs in the cluster and fetches changes from Git, the pipeline doesn't need to reach the private API on every deploy, only at bootstrap. That consequence for the private network is my own reading of the model the docs describe. The price shows in the figure: the cluster has to reach the Git repository (the "pull" arrow), which brings us back to the egress design I left out of scope.
- **Out of scope, on purpose.** The cluster's egress design. The provider accepts `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` and `none` in `outbound_type`. It is a separate decision, with a firewall or NAT, and I left it out to keep the example clean.

### Naming pattern

I name everything `<type>-<environment>-<region>-<seq>`: `vnet-prod-brs-01`, `aks-prod-brs-01`. The type follows the [Cloud Adoption Framework abbreviations](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations) (`vnet`, `snet`, `aks`, `kv`, `rg`, `pep` for private endpoint, `pgsql` for PostgreSQL flexible server, `cr` for container registry and `id` for managed identity), and the component order is the one Microsoft documents in [define your naming convention](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming). `brs` is my pattern's short code for Brazil South, not a Microsoft code.

Two points from that documentation weigh on the decisions: most names can't be changed after creation, so only what never changes goes in the name (the rest goes in tags); and some names are global and have their own rules. According to the [naming rules table](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules), Key Vault is global, 3 to 24 characters, letters, numbers and hyphens, and ACR is global, 5 to 50 characters and **letters and numbers only**. That's why the example registry is called `crprodbrs01`, with no hyphens, and the application's Key Vault, `kv-orders-prod-brs-01`.

The resource name is also the state name: the network `tfstate` is `vnet-prod-brs-01.tfstate`. Anyone looking at the state container sees exactly what each blob holds.

### Who owns what

The question that defines the split into stacks is "who changes this, and how often". For this architecture, I split it like this:

| Stack (folder) | Resources | Modules | State `key` |
|---|---|---|---|
| `vnet` | VNet, subnets, NSGs, Private DNS zones | `network` | `vnet-prod-brs-01.tfstate` |
| `aks` | AKS, ACR and its Private Endpoint | `aks`, `acr`, `private-endpoint` | `aks-prod-brs-01.tfstate` |
| `app-orders` | Dedicated PostgreSQL, Key Vault and its Private Endpoint, the application's identity | `postgresql`, `key-vault`, `private-endpoint`, `workload-identity` | `app-orders-prod-brs-01.tfstate` |
| *(outside Terraform)* | Argo CD (bootstrap) and the `orders` pod in the cluster | Bootstrap script and manifests in `infra/argocd` | no state |

Notice two details. The `private-endpoint` module is used by two stacks: that is the kind of reuse that justifies a module, and HashiCorp's refactoring guide recommends grouping into a module the set of resources you create in several configurations. And the `aks` stack also holds the ACR: it takes the name of its main resource, and the registry is a supporting resource of it.

### The database belongs to the application, and the application doesn't belong to Terraform

Two decisions in this design deserve a justification.

**PostgreSQL is dedicated to the application and enters as a module call inside its stack.** I don't create a shared database server in a "data" stack. The `orders` application asks for its database the same way it asks for the Key Vault and the identity, and the database lifecycle follows the application's. Size, SKU and storage become parameters of the module call, per application. This is my choice, with pros and cons:

- **Pros:** blast radius per application (a mistake in the `app-orders` stack doesn't reach another application's database), privilege per application, sizing per application and complete removal when the application goes away.
- **Cons:** more servers to pay for and operate (backup, patching, monitoring) and more resources in the delegated subnet. If many small applications share the same usage profile, a shared server may make more sense. Evaluate with your own numbers.

**The pod enters the cluster through Argo CD, not Terraform.** The criterion is HashiCorp's own: group by volatility and separate stateful from stateless. The application changes several times a day and is stateless. The database changes rarely and holds data. If the pod were a Terraform resource, every new image version would go through `plan` and `apply` in the same state as the database. With GitOps, the most frequent step of the flow becomes a commit to the manifests, and the state that can least afford a mistake stays away from it. This reading of HashiCorp's rule for the Argo CD case is mine. The page doesn't mention GitOps.

In practice, three Terraform stacks (`vnet`, `aks` and `app-orders`) and the Argo CD bootstrap (once per cluster) run through the pipeline, and you can tick any subset. After the bootstrap, the application evolves through Git.

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
│   ├── vnet/
│   ├── aks/
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

- A **module** is the *how*: a reusable recipe for network, AKS, database. It lives directly in `modules/<resource>`, named after the domain (`network`, `aks`, `postgresql`) with no subfolders per team or per project. No backend, no state.
- A **stack** is the *what and where*: a Terraform root that calls modules, has its own backend and is what the pipeline executes. The folder is per type (`vnet`, `aks`, `app-orders`). Each **instance** (environment, region and sequence) is a different state of the same folder.
- An **instance** is just data: a `.tfvars` and a different `key` in the backend. `prod-brs-01` and `dev-brs-01` run the same code.

This is where Parnas comes in. In the classic paper [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) (CACM, 1972), the abstract says the effectiveness of a modularization depends on the criteria used to divide the system into modules. It's a paper about software, not IaC, so the link is an analogy. But it's the right question to ask before creating folders: split by what? I split by lifecycle and owner, not by size or resource type.

### The backend: one state per stack and per instance

Each stack declares an empty backend and receives the rest at `init` time (what Terraform calls *partial configuration*):

```hcl
# infra/stacks/aks/main.tf
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
  -backend-config="key=aks-prod-brs-01.tfstate"
```

In the end, the container looks like this:

```text
tfstate/
├── vnet-dev-brs-01.tfstate
├── vnet-prod-brs-01.tfstate
├── aks-dev-brs-01.tfstate
├── aks-prod-brs-01.tfstate
├── app-orders-dev-brs-01.tfstate
└── app-orders-prod-brs-01.tfstate
```

Two things deserve attention. The state account should live outside what Terraform manages in the stacks, and authentication should use Microsoft Entra ID rather than access keys (the [docs](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) mark the access key as "not recommended for new workloads" and list `Storage Blob Data Contributor` on the container as the least-privilege option).

### The three stacks

All stacks receive two variables, `environment` and `instance`, and derive their names from the same suffix.

**`vnet`** calls the `network` module and owns the VNet, the subnets and the DNS zones:

```hcl
# infra/stacks/vnet/main.tf (terraform {} and provider as in the backend example)
variable "environment" { type = string }   # prod
variable "instance"    { type = string }   # brs-01

locals {
  suffix = "${var.environment}-${var.instance}"   # prod-brs-01
}

module "network" {
  source = "../../modules/network"

  name          = "vnet-${local.suffix}"          # vnet-prod-brs-01
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

The module creates the resource group (`rg-vnet-prod-brs-01`) and receives the subnet map with an optional delegation attribute:

```hcl
# infra/modules/network/variables.tf (excerpt)
variable "subnets" {
  type = map(object({
    cidr       = string
    delegation = optional(string)
  }))
}
```

**`aks`** doesn't create networking. It looks up the subnet and the ACR zone the `vnet` stack already created, and creates the registry, the private endpoint and the cluster:

```hcl
# infra/stacks/aks/main.tf (continues the terraform/provider block above)
variable "environment" { type = string }
variable "instance"    { type = string }

locals {
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-${local.suffix}"
  vnet_name  = "vnet-${local.suffix}"
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

  name = "cr${var.environment}${replace(var.instance, "-", "")}"   # crprodbrs01 (letters and numbers only)
}

module "acr_private_endpoint" {
  source = "../../modules/private-endpoint"

  name                = "pep-cr-${local.suffix}"
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.acr.id
  subresource_name    = "registry"
  private_dns_zone_id = data.azurerm_private_dns_zone.acr.id
}

module "aks" {
  source = "../../modules/aks"

  name      = "aks-${local.suffix}"               # aks-prod-brs-01
  subnet_id = data.azurerm_subnet.aks.id
  acr_id    = module.acr.id
}
```

And what makes the cluster private and enables Workload Identity lives in the module:

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

**`app-orders`** is the application's stack. Here the database is a dedicated module call. It looks up the network and the DNS zones from `vnet`, and the cluster's OIDC issuer from `aks`:

```hcl
# infra/stacks/app-orders/main.tf (terraform {} and provider as in the backend example)
variable "environment"       { type = string }
variable "instance"          { type = string }
variable "postgres_sku_name" { type = string }
variable "postgres_storage_mb" { type = number }

locals {
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-${local.suffix}"
  vnet_name  = "vnet-${local.suffix}"
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
  name                = "aks-${local.suffix}"
  resource_group_name = "rg-aks-${local.suffix}"
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

  name                 = "id-orders-${local.suffix}"
  oidc_issuer_url      = data.azurerm_kubernetes_cluster.this.oidc_issuer_url
  namespace            = "orders"
  service_account_name = "orders"
  key_vault_id         = module.key_vault.id
}

output "postgres_fqdn" { value = module.postgresql.fqdn }
output "app_client_id" { value = module.workload_identity.client_id }
```

In the `postgresql` module, what matters for the private network is this (the provider's example uses exactly these attributes):

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

One detail from the [provider documentation](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server): its example uses `depends_on` on the link between the DNS zone and the VNet. With the split into stacks, that `depends_on` becomes **execution order**: `vnet` runs first. That is exactly what the pipeline's `dependsOn` will guarantee further down.

The `private-endpoint` module, reused by the `aks` and `app-orders` stacks:

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

And the `workload-identity` module, which creates the application's identity and federates it with the Kubernetes service account. The [AKS Workload ID documentation](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster) shows the same resources, including the `Key Vault Secrets User` role for reading secrets:

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

The example Key Vault uses RBAC (`rbac_authorization_enabled = true`) and `public_network_access_enabled = false`, both documented attributes of the `azurerm_key_vault` resource.

Notice that the `aks` and `app-orders` stacks **don't read another stack's state**. They look up the network and the cluster through the Azure API with `data sources`. That's a conscious decision, and I come back to it below.

If modules live in another repository, `source` points to a tag so the version is pinned: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## Application deploy: Argo CD (GitOps)

With the infrastructure up, the `orders` pod enters the cluster through **Argo CD**, which the [documentation](https://argo-cd.readthedocs.io/en/stable/) describes as a declarative GitOps continuous delivery tool for Kubernetes: Git is the source of truth for the desired state, and a controller continuously compares the live state against that desired state. Manifests can be Kustomize, Helm charts or a directory of YAML/JSON.

This changes two things in the pipeline. The application deploy stops being one of its steps and becomes a commit in Git. And the pipeline only installs Argo CD, once per cluster (the **bootstrap**).

### The `infra/argocd` directory

All the GitOps lives in a dedicated directory inside `infra/`:

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

The root Application follows the *app of apps* pattern from the [cluster bootstrapping documentation](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/). The same page recommends looking at ApplicationSets, particularly the cluster generator, for most scenarios; I chose app of apps because it's simpler to show. The doc uses a Helm example and says you can use another tool, so I used a directory of manifests. I haven't run this specific format.

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

The application's Application points to the instance's overlay. The format is that of a [minimal Application](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/), and the `resources-finalizer.argocd.argoproj.io` finalizer makes deleting the Application also delete the resources it manages (without it, the doc warns that doesn't happen):

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

The `CreateNamespace=true` option creates the destination namespace if it doesn't exist, as the [sync options doc](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/) describes. In the example, prod has no `syncPolicy.automated`: merging the pull request updates Git, and syncing is a manual step. In dev and hml, I would use `automated`, which is optional. The [automated sync doc](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/) also warns that by default it doesn't delete resources that left Git: pruning is an explicit option.

The manifests live in a base, with what is the same across all instances, and in one overlay per instance. Since there is a `kustomization.yaml` at the Application's path, Argo CD renders with Kustomize, as the [doc](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/) describes. The two names Workload Identity requires are in the [AKS documentation](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster): the `azure.workload.identity/client-id` annotation on the service account and the `azure.workload.identity/use: "true"` label on the pods.

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
    newName: crprodbrs01.azurecr.io/orders
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

The `subject` of the `workload-identity` module (`system:serviceaccount:orders:orders`) must match the Application's namespace and the service account name. The two overlay values that come from Terraform (`app_client_id` and `postgres_fqdn`) are outputs of the `app-orders` stack. How they reach Git is up to you: copy them in the pull request that changes Terraform, or have a pipeline step that opens that PR. What matters is that the bridge between Terraform and Git is explicit. Notice also that no secret goes into Git: the application reads Key Vault through Workload Identity.

### The Argo CD bootstrap

The script installs Argo CD with the command from the [installation documentation](https://argo-cd.readthedocs.io/en/stable/getting_started/) and applies the instance's root Application:

```bash
#!/usr/bin/env bash
# infra/scripts/bootstrap-argocd.sh  ->  bootstrap-argocd.sh <env> <instance>
set -euo pipefail

env="$1"; instance="$2"
suffix="${env}-${instance}"                       # prod-brs-01
argocd_version="v3.2.0"                           # pin the version; check the current one

az aks get-credentials \
  --resource-group "rg-aks-${suffix}" \
  --name "aks-${suffix}" \
  --overwrite-existing

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n argocd --server-side --force-conflicts \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${argocd_version}/manifests/install.yaml"

kubectl apply -n argocd -f "infra/argocd/bootstrap/root-${suffix}.yaml"
```

A few points about it:

- The doc uses `--server-side --force-conflicts` because some Argo CD CRDs (like ApplicationSet) exceed the annotation size limit of client-side `kubectl apply`. It also recommends pinning a version in production. `v3.2.0` is the example the doc itself uses, so check the current version.
- `az aks get-credentials` needs network and DNS access to the private API. That's why the bootstrap runs on the VNet's self-hosted agent.
- The agent and the cluster need to reach the origin of `install.yaml` and of the Argo CD images. In a closed environment, that goes into the egress design I left out of scope.
- If the Git repository is private, Argo CD needs credentials. The [private repositories doc](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/) lists HTTPS, SSH and GitHub App. How to provision them is another subject that I didn't cover here.
- Use a dedicated identity for the bootstrap, different from the one that runs Terraform. The one that applies infrastructure doesn't need to touch workloads, and the one that installs Argo CD doesn't need to create networks.

### How the application changes afterwards

A new `orders` version becomes a change to the overlay's `newTag`, in a pull request. The review of that PR is the deploy approval, and the repository's branch policy is the control. In prod, the next step is the manual sync. At no point does the infrastructure pipeline come into play, nor does it need to reach the cluster API.

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

  - name: vnet
    displayName: "vnet · private network"
    type: boolean
    default: false

  - name: aks
    displayName: "aks · cluster and ACR"
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
  - ${{ if eq(parameters.vnet, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: vnet
          stageName: vnet
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}

  - ${{ if eq(parameters.aks, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: aks
          stageName: aks
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}
          dependsOn:
            - ${{ if eq(parameters.vnet, true) }}:
                - vnet

  - ${{ if eq(parameters.appOrders, true) }}:
      - template: templates/terraform-stack.yml
        parameters:
          stack: app-orders
          stageName: app_orders
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          action: ${{ parameters.action }}
          dependsOn:
            - ${{ if eq(parameters.vnet, true) }}:
                - vnet
            - ${{ if eq(parameters.aks, true) }}:
                - aks

  - ${{ if eq(parameters.argocd, true) }}:
      - template: templates/argocd-bootstrap.yml
        parameters:
          stageName: argocd
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          dependsOn:
            - ${{ if eq(parameters.aks, true) }}:
                - aks
            - ${{ if eq(parameters.appOrders, true) }}:
                - app_orders
```

The key is the `${{ if ... }}` expressions. They are **template expressions**, evaluated when the pipeline is assembled (the [template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) docs explain they are resolved at initialization). That means the stage of an unticked step **doesn't exist** in the run. It doesn't show up as "skipped", it doesn't use an agent, it just isn't there.

The conditional `dependsOn` lists solve an annoying detail: if you declare a dependency on a stage that wasn't included, pipeline validation fails. Here each dependency only exists when the corresponding step was selected, and the list ends up empty when none was. It's the pipeline translation of that `depends_on` the provider documentation uses inside a single stack. I haven't run this specific conditional-list format, but it uses the conditional insertion into sequences that the [template expressions documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) describes.

### Variation: a multi-select list

Instead of one boolean per step, you can use a `stringList` in the main pipeline, where the run screen lets you tick several items at once:

```yaml
parameters:
  - name: stacks
    displayName: Steps to run
    type: stringList
    values: [vnet, aks, app-orders, argocd]
    default: [vnet]

stages:
  - ${{ each stack in parameters.stacks }}:
      - ${{ if eq(stack, 'vnet') }}:
          - template: templates/terraform-stack.yml
            parameters:
              stack: vnet
              stageName: vnet
              environment: ${{ parameters.environment }}
              instance: ${{ parameters.instance }}
              action: ${{ parameters.action }}
```

The documentation shows this iteration with `each` over a `stringList`. I avoided `contains` because, per the [expressions reference](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions), it compares strings; for arrays there is `containsValue`, but the page itself describes it as of limited use outside pipeline decorators. I haven't run this example, so validate it before adopting. With this form, the conditional `dependsOn` lists from the main example tend to get more cumbersome.

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

And the Argo CD bootstrap template, which uses the same Environment (and therefore the same approvals) and a dedicated service connection:

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

What's going on:

- One **service connection per environment** for Terraform (`sc-terraform-dev`, `sc-terraform-prod`) and another for the Argo CD bootstrap (`sc-aks-bootstrap-prod`), ideally with identity federation. No stored secret.
- The pool is `private-agents`, a self-hosted pool inside the VNet. In an environment where ACR (and, if you also close it, the state account) doesn't accept public access, the Microsoft-hosted agent can't reach those resources, and the cluster API is private.
- The `deployment` jobs use an Azure DevOps **Environment**. That's where you configure approvals and checks for `prod`. Who approves the `apply` and the production bootstrap is an Environment decision, not a YAML one. According to the [documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), approvals and checks aren't defined in the YAML and whoever edits the YAML can't change them; the resource administrators (Environment, service connection, etc.) manage them through the web interface.
- The `plan` is published as an artifact and `apply` applies **that** plan. What was reviewed is what gets applied, not a new plan computed after approval.

### The script both steps use

```bash
#!/usr/bin/env bash
# infra/scripts/tf.sh  ->  tf.sh <plan|apply> <stack> <env> <instance>
set -euo pipefail

cmd="$1"; stack="$2"; env="$3"; instance="$4"
suffix="${env}-${instance}"                         # prod-brs-01
state_key="${stack}-${suffix}.tfstate"              # vnet-prod-brs-01.tfstate
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
      vnet:
        description: "vnet · private network"
        type: boolean
        default: false
      aks:
        description: "aks · cluster and ACR"
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
  vnet:
    if: ${{ inputs.vnet }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: vnet
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  aks:
    needs: [vnet]
    if: ${{ !cancelled() && !failure() && inputs.aks }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: aks
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  app-orders:
    needs: [vnet, aks]
    if: ${{ !cancelled() && !failure() && inputs.app_orders }}
    uses: ./.github/workflows/terraform-stack.yml
    with:
      stack: app-orders
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
      action: ${{ inputs.action }}

  argocd:
    needs: [aks, app-orders]
    if: ${{ !cancelled() && !failure() && inputs.argocd }}
    uses: ./.github/workflows/argocd-bootstrap.yml
    with:
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
```

There is an important difference from Azure DevOps here. On GitHub the condition is evaluated **at runtime**, so an unticked job shows up as *skipped*. And, according to the [documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), if a job fails or is skipped, all jobs that need it are skipped too, unless they use a conditional expression that lets them continue. `!cancelled() && !failure()` fixes that: "run if nothing failed, even if the dependency was skipped". One more detail: the `inputs` context preserves booleans, while `github.event.inputs` converts everything to strings; that's why I use `inputs.vnet` directly in the `if`.

### The Terraform reusable workflow

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

### The Argo CD bootstrap reusable workflow

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

The runner needs `az` and `kubectl` installed. The login uses the `azure/login` action, which is the flow [GitHub's documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) shows, and `bootstrap-argocd.sh` is the same script as in Azure DevOps.

The points that make a difference:

- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) are called at the job level, receive `inputs` through `with`, and the type must match what was declared (boolean, number or string). The documentation allows chaining up to ten levels of workflows (the caller plus nine). One detail that fits our design: the job that calls the reusable workflow can't use `environment`; the `environment` is declared by the job inside the reusable workflow, as we did.
- For Terraform, authentication is via **OIDC**. `ARM_USE_OIDC` makes the provider request the token from GitHub and exchange it for Azure access, with no stored secret. Here I let Terraform itself do the exchange: per the [provider OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc), on GitHub Actions it detects `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` on its own, as long as the workflow has `id-token: write`. The same guide notes the federated credential is per Environment, branch, pull request or tag, and the values must match exactly.
- When the job uses an Environment, the token *subject* has the format `repo:ORG/REPO:environment:NAME`. That lets you create **one federated credential per environment** in Entra ID: `prod` only accepts tokens from jobs in the `prod` Environment. Least privilege and per-environment separation almost for free. Mind a recent change: per [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc), repositories created after July 15, 2026 (and renamed or transferred after that date) use an immutable subject by default, which includes the owner and repository IDs, while older ones keep the name-based format until you opt in. [Microsoft recommends migrating](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) name-based credentials. In other words, the federated credential must match your repository's format. The reference shows the environment subject example (`repo:octo-org/octo-repo:environment:Production`) and, for the immutable format, the branch example (`repo:octo-org@123456/octo-repo@456789:ref:refs/heads/main`), so confirm what the environment subject looks like in your case. The documentation also recommends protecting the Environment with rules (for example, restricting branches and tags) when it is used in OIDC policies.
- In this example, `plan` and `apply` run in the same job, applying the saved plan. The cost is that if the Environment has *required reviewers*, approval is requested **before** the plan. If that bothers you, use two Environments (`dev-plan` and `dev-apply`, for example) or split into two jobs.
- `runs-on` points to a self-hosted runner inside the VNet, for the same reason as the Azure DevOps pool: the network is private. The `self-hosted, linux, private-vnet` labels are from the example; use the ones from your environment.

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

When one stack depends on another, there are two ways to read the information. In the example, `aks` and `app-orders` need the subnet and DNS zones from `vnet`, and `app-orders` needs the cluster's OIDC issuer:

- `terraform_remote_state`: reads the other stack's state outputs. Direct, but the reader needs access to the entire state file (which may hold sensitive data) and you couple one stack to the other's state layout.
- **Provider data source**: queries the real resource through the Azure API. It requires a naming convention (the `type-environment-region-seq` pattern plays that role), but gives looser coupling and doesn't need access to someone else's state. For the OIDC issuer, the `azurerm_kubernetes_cluster` data source exposes the `oidc_issuer_url` attribute.

HashiCorp doesn't forbid sharing outputs: in its workspace best practices it recommends exposing only the outputs other workspaces need (through `tfe_outputs`), precisely to reduce the risk of leaking sensitive information from the state. I prefer the data source by default and use `remote_state` when I need an output that doesn't exist as a queryable resource. That preference is mine, based on experience, not a HashiCorp rule, so evaluate it in your context.

On coupling, DORA's [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) capability is a useful parallel: it states that in tightly coupled architectures small changes can cause cascading failures. It is about software architecture and teams, so the link to IaC is an analogy, but the reasoning is the same: the less one stack knows about the other's internals, the less a change spreads.

---

## Traps I've seen

1. **A parameter is not a vault.** Microsoft warns that parameter values are expanded when the template is parsed and may show up in logs. Secrets don't go in parameters. The [*Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) study (Rahman, Parnin and Williams, ICSE 2019) analyzed 15,232 IaC scripts and found 21,201 security smell occurrences, 1,326 of them hard-coded passwords, and showed a hard-coded secret can persist for up to 98 months (median 20), so don't count on "we'll remove it later". The Azure DevOps documentation also says to validate and restrict allowed parameter values, apply least privilege and keep credentials in secret variables, Key Vault or variable groups.
2. **Partial selection creates drift.** If someone ticks only the cluster step after a network change that wasn't applied, the plan will fail or, worse, be applied on top of an outdated base. I handle it with `plan` as the default action and a scheduled job that runs `plan` on everything to detect drift.
3. **Execution and destroy order.** On create, the order is `vnet`, `aks`, `app-orders` and the `argocd` bootstrap. On `destroy` it's the reverse, and the database holds data. So I simply don't offer `destroy` as an `action` value in `prod`.
4. **Application created before the database.** If the `orders` Application enters Git before the database and the identity exist, the pod starts without being able to connect. `dependsOn` protects the bootstrap when the steps come in the same run, but it doesn't protect a pull request that adds the Application later. The practical order is to apply the `app-orders` stack before merging the PR that creates the Application.
5. **Stale Terraform values in the manifests.** `app_client_id` and `postgres_fqdn` come from Terraform. If someone recreates the database or the identity and forgets to update the overlay, Argo CD keeps syncing the old values, because as far as it is concerned Git is right. Treat the bridge between Terraform and Git as part of the design, not a detail.
6. **Who can click "Run" is part of access control.** The parameter form is an infrastructure control interface. Restrict who can run the pipeline and protect the production Environment.
7. **Splitting too much.** Twenty small states become twenty dependency points. Split by lifecycle and owner, not by size. It's Parnas's criterion, again.
8. **Trigger runs use defaults.** If you attach the pipeline to a `trigger`, the automatic run uses the parameters' default values. Hence `trigger: none` in the example and `default: false` on the steps.
9. **A private network also closes your pipeline's door.** With ACR without public access, the Microsoft-hosted agent can no longer reach it, as the ACR docs warn, and the cluster API only answers inside the network. Plan the self-hosted agent or runner inside the VNet from the start. With Argo CD, the pipeline only needs the API at bootstrap, but the cluster now needs to reach out to Git. If you also close public access on the state account, the same applies to `terraform init`.
10. **App of apps is an admin tool.** The Argo CD docs warn that creating Applications in arbitrary projects is an admin-level capability: only admins should have push access to the parent Application's repository, and pull requests need review, paying attention to each Application's `project` field. Protect the `infra/argocd/apps` path with a branch policy and reviewers.
11. **Prune and finalizer have effects.** Automated sync doesn't delete resources that left Git unless you enable pruning. And, with the finalizer, deleting an Application also deletes what it manages. Decide this on purpose, especially in prod.

---

## Pros and cons

**Pros**

- Smaller blast radius and changes that are easier to review.
- Least privilege per stack, per environment and per application.
- Faster plans and no lock contention.
- One pipeline to maintain, with the same code in every instance.
- Modules reused across stacks (the example's `private-endpoint`).
- Dedicated database per application, with a lifecycle tied to the application.
- Frequent application deploys (through Git) kept apart from the state that can least afford a mistake.
- Auditable deploys: the commit history and the pull request review are the record and the approval.
- Clear history: the run records what was selected, and the state name says what it holds.

**Cons**

- More moving parts to understand: modules, stacks, backends, templates, manifests.
- Dependencies between stacks become explicit and you have to manage them, including the Terraform → manifests bridge.
- Migrating from a big state needs planning (HashiCorp's [refactoring guide](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) says to run `terraform plan` on the source configuration and confirm it won't change anything).
- Manual selection opens room for human error unless you add guard rails (approvals, allowed values, `plan` as default).
- A database per application increases cost and operations.
- One more component to operate (Argo CD) and a cluster that needs to reach the Git repository.
- A wrong split trades one problem for another: coupling between states.
- A private network requires agents inside the network and careful DNS design.

---

## Checklist to get started

- [ ] Map resources by lifecycle, owner and stateful/stateless before splitting
- [ ] Define the naming pattern (`type-environment-region-seq`) before the first `apply`, because most names can't change afterwards
- [ ] Extract modules for what repeats, with a direct domain name in `modules/<resource>`
- [ ] One stack per Terraform root, with an empty `backend "azurerm" {}`
- [ ] `key` = `<stack>-<environment>-<region>-<seq>.tfstate`
- [ ] Authentication through identity federation, no secrets
- [ ] Parameters: `environment` and `instance` with a closed list, `action` defaulting to `plan`, one boolean per step
- [ ] Approval on the production Environment, for Terraform and for the Argo CD bootstrap
- [ ] Saved `plan` applied as an artifact
- [ ] Dedicated database as a module call in the application's stack, if that is your model
- [ ] Application deploy through Argo CD (GitOps), with manifests in `infra/argocd` and one Application per instance
- [ ] Production deploy approval on the pull request (branch policy) and, if you prefer, manual sync
- [ ] Argo CD bootstrap through the pipeline, once per cluster, with its own identity
- [ ] Self-hosted agents or runners inside the VNet, if the network is private
- [ ] Scheduled `plan` job to detect drift
- [ ] Document the dependency order between steps

---

## FAQ

**Can I use `object` instead of several booleans in Azure DevOps?**
Yes, and you can iterate with `${{ each }}`, which shortens the YAML. The cost is that the input is less friendly than checkboxes and easier to get wrong. For a middle ground, see the `stringList` variation above. For a few steps I prefer booleans.

**What if I want to run every step at once?**
Tick them all. If that's the most common case, consider an `all` parameter or an execution profile, but keep individual selection available.

**Why Argo CD, and not a pipeline deploy or Terraform's Helm provider?**
Because the application changes far more often than the database and the network, and HashiCorp's group-by-volatility rule points to keeping that step out of the infrastructure state. Argo CD also keeps the cluster reconciled with Git, and the pipeline doesn't need to reach the private API on every deploy. It's a design choice of mine. If your team doesn't want to operate Argo CD, Helm in the pipeline works too, with the private API reachable by the agent.

**Can I use Helm charts instead of Kustomize?**
Yes. The Argo CD docs list Kustomize, Helm charts and directories of YAML as manifest formats. The Application points to the chart instead of the overlay, and the per-instance values live in Git.

**Why does PostgreSQL use a delegated subnet and not a Private Endpoint?**
Because I chose network integration (private access). The [documentation](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) presents two networking options for PostgreSQL Flexible Server: private access (VNet integration, what I used) or public access with a Private Endpoint. Check what changes in each before creating the server.

**Does this work with Bicep or OpenTofu?**
The design of parameters, independent stacks and a single pipeline works for any IaC. What's Terraform-specific here is `tfstate` and the backend. OpenTofu uses the same `azurerm` backend model; confirm the particulars in its documentation.

**How do I migrate from a single state?**
Plan the grouping, move resources with `removed` and `import` blocks (HashiCorp's refactoring guide details it), and confirm `terraform plan` shows no changes in any stack. Do it in dev first.

**Do I need Terraform Cloud for this?**
No. What I showed uses the `azurerm` backend and the pipeline. Terraform Cloud has the workspace concept, which solves part of this differently.

---

## Closing

What convinced me most was realizing the checkbox in the pipeline is just the visible tip. What holds the idea up is the design underneath: modules that concentrate the *how*, stacks that isolate the *what*, states that isolate the *impact*, names that say what each thing is and identities that isolate the *who*. With that in place, the parameter is just the way you choose.

If you only have one state today, you don't need to split everything at once. Start with what changes most often or what would hurt most to break, usually network and data, and go from there.

---

## References

**Official documentation**
- [Azure Pipelines — Runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters)
- [Azure Pipelines — Template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)
- [Azure Pipelines — Template parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-parameters)
- [Azure Pipelines — Expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions)
- [Azure Pipelines — Approvals and checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
- [Azure Pipelines — AzureCLI@2 task](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2)
- [GitHub — Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub — OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch now supports 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — OIDC in Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — GitHub immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — terraform plan and `-target`](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [HashiCorp — azurerm backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Terraform azurerm — OIDC guide](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)
- [Terraform azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [Terraform azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [Terraform azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)

**GitOps (Argo CD)**
- [Argo CD — Overview](https://argo-cd.readthedocs.io/en/stable/)
- [Argo CD — Installation (getting started)](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [Argo CD — Cluster bootstrapping (app of apps)](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
- [Argo CD — Declarative setup (Application)](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Argo CD — Automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [Argo CD — Sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)
- [Argo CD — Kustomize](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)
- [Argo CD — Private repositories](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/)

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
