---
title: "Private AKS and PostgreSQL: a reference architecture with Terraform and Argo CD"
description: "A reference architecture with private AKS, a per-application PostgreSQL and Argo CD deploys, in three Terraform stacks."
pubDate: 2026-11-22
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "aks", "argocd", "gitops", "postgresql", "private-link", "workload-identity", "platform-engineering", "azure"]
readingTime: "15 min"
lang: "en"
draft: true
---

> **TL;DR**
> - Reference architecture: an application on AKS with a dedicated PostgreSQL, everything in a private network (private cluster, delegated subnet, Private Endpoints and Private DNS zones).
> - Terraform delivers the network, the cluster, the ACR, the database, the Key Vault and the application's identity, in three stacks. The pod enters the cluster through **Argo CD**, from manifests in `infra/argocd`.
> - The pipeline only installs Argo CD, once per cluster. After that, a deploy is a pull request.
> - The cost: agents inside the network, a cluster that needs to reach Git, and an explicit bridge between Terraform and the manifests.
> - This is **Part 2 of 2**. [Part 1](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/) explains how to split into stacks and trigger each one by parameter.

---

In [Part 1](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/) I showed how to split infrastructure into stacks and choose what runs by parameter. Here is the architecture behind the examples: what each stack delivers, the code of each one and the application deploy through Argo CD. The names (`vnet-core-prod-brs-01` and company) and the parameters come from Part 1.

> **How to read this article.** Every link points to official documentation or published research. When an idea is mine, and not the source's, I mark it as **my reading**. The code is simplified: adapt names, versions and permissions to your environment and try it in dev.

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

The names follow the pattern from [Part 1](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/): `<type>-<name>-<environment>-<region>-<seq>`, with `core` for the platform and `orders` for the application. The resource name is also the state name.

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

## The stacks and the modules

The snippets below show the architecture's three stacks and modules. All receive `environment` and `instance` (the parameters from [Part 1](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/)) and derive their names from the same suffix (`prod-brs-01`). The backend and the per-stack `init` are also in Part 1.

**`vnet-core`** calls the `network` module and owns the VNet, the subnets and the DNS zones:

```hcl
# infra/stacks/vnet-core/main.tf (terraform {} and provider as in the backend example from Part 1)
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
# infra/stacks/aks-core/main.tf (continues the terraform/provider block from the Part 1 backend section)
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
# infra/stacks/app-orders/main.tf (terraform {} and provider as in the backend example from Part 1)
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

### Extending Part 1's pipeline

The bootstrap enters [Part 1's](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/) pipeline as a fourth step. In Azure DevOps, add the parameter and the stage to the orchestrator:

```yaml
# infra/pipelines/azure-pipelines.yml (additions)
parameters:
  # ...
  - name: argocd
    displayName: "argocd · install and root Application (once per cluster)"
    type: boolean
    default: false

stages:
  # ...
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

And the bootstrap template, which uses the same Environment (and therefore the same approvals), with a dedicated service connection:

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

In GitHub Actions, add the input and the job to the orchestrator:

```yaml
# .github/workflows/infra.yml (additions)
on:
  workflow_dispatch:
    inputs:
      # ...
      argocd:
        description: "argocd · install and root Application (once per cluster)"
        type: boolean
        default: false

jobs:
  # ...
  argocd:
    needs: [aks-core, app-orders]
    if: ${{ !cancelled() && !failure() && inputs.argocd }}
    uses: ./.github/workflows/argocd-bootstrap.yml
    with:
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
```

And the bootstrap reusable workflow:

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

The bootstrap uses its own service connection (or federated identity), separate from the one that runs Terraform: whoever applies infrastructure doesn't need to touch workloads, and whoever installs Argo CD doesn't need to create networks.

### How the application changes afterwards

A new `orders` version becomes a change to the overlay's `newTag`, in a pull request. The review of that PR is the deploy approval, and the repository's branch policy is the control. In prod, the next step is the manual sync. At no point does the infrastructure pipeline come into play, nor does it need to reach the cluster API.

---

## Traps I've seen

1. **The bridge between Terraform and Git.** If the `orders` Application enters Git before the database and the identity exist, the pod starts without being able to connect: apply the `app-orders` stack before merging the PR that creates the Application. And if someone recreates the database or the identity and forgets to update the overlay, Argo CD keeps syncing the old values, because as far as it is concerned Git is right.
2. **A private network also closes your pipeline's door.** Plan the self-hosted agent or runner inside the VNet from the start. With Argo CD, the pipeline only needs the API at the bootstrap, but the cluster now needs to reach out to Git.
3. **Argo CD has traps too.** The doc warns that app of apps is an admin capability: only admins should have push access to the parent Application's repository, and pull requests need review, paying attention to the `project` field. Protect `infra/argocd/apps` with a branch policy. And remember automated sync only deletes what left Git if you enable pruning, and that with the finalizer, deleting an Application deletes what it manages. Decide this on purpose, especially in prod.

---

## Pros, cons and when I wouldn't use it

**Pros**

- A dedicated database per application, with the application's lifecycle and its own blast radius.
- Frequent deploys through Git, away from the state that can least afford a mistake, and auditable: the commit history and the PR review are the record and the approval.
- Private network end to end, with Workload Identity and no secrets in Git.

**Cons**

- A database per application increases cost and operations.
- One more component to operate (Argo CD) and a cluster that needs to reach Git.
- A private network requires agents inside the network and careful DNS design.
- The bridge between Terraform and the manifests is manual and needs to be explicit.

**When I wouldn't use it.** With a few small applications and a similar usage profile, a shared database server and a simple deploy (Helm in the pipeline) cost less than a database per application and Argo CD. And if your team doesn't want to operate a controller inside the cluster, Argo CD isn't worth it.

---

## Checklist to get started

- [ ] Dedicated database as a module call in the application's stack, if that is your model
- [ ] Global resource names (ACR, Key Vault) checked against each type's rules
- [ ] Self-hosted agents or runners inside the VNet, with access to the cluster API
- [ ] Cluster egress design defined
- [ ] Deploy through Argo CD, with manifests in `infra/argocd` and one Application per instance
- [ ] Production deploy approval on the pull request (branch policy) and, if you prefer, manual sync
- [ ] `infra/argocd/apps` protected with a branch policy and reviewers
- [ ] Argo CD bootstrap through the pipeline, once per cluster, with its own identity
- [ ] Git repository credentials configured in Argo CD, if it is private
- [ ] Bridge between Terraform outputs and the manifests documented

---

## FAQ

**Why Argo CD, and not a pipeline deploy or Terraform's Helm provider?**
Because the application changes far more often than the database and the network, and HashiCorp's volatility rule points to keeping that step out of the infrastructure state. Argo CD also keeps the cluster reconciled with Git, and the pipeline doesn't need to reach the private API on every deploy. It's a design choice of mine: if your team doesn't want to operate Argo CD, Helm in the pipeline works too. And Argo CD accepts Helm charts, Kustomize and directories of YAML ([docs](https://argo-cd.readthedocs.io/en/stable/)), so you can keep charts in place of the overlay.

**Why does PostgreSQL use a delegated subnet and not a Private Endpoint?**
Because I chose network integration (private access). The [documentation](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) presents two options for PostgreSQL Flexible Server: private access (what I used) or public access with a Private Endpoint. Check what changes in each before creating the server.

---

## Closing

The architecture is just the context. What matters is still the design underneath: who owns what, what changes how often and what can break what. With separate stacks, a database per application and deploys through Git, each change lands in the right place with the right blast radius.

The cluster's egress design and the bridge between Terraform and the manifests are the two parts I left most open here. If you've solved them well, I'd like to know how. And if you haven't read it yet, [Part 1](/en/blog/en-us/2026-11-21/pipeline-parameters-choose-what-to-provision/) shows how to trigger each stack by parameter.

---

## References

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

**Terraform**
- [azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)
