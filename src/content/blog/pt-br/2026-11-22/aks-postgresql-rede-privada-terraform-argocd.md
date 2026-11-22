---
title: "AKS e PostgreSQL em rede privada: arquitetura de referência com Terraform e Argo CD"
description: "Uma arquitetura de referência com AKS privado, PostgreSQL dedicado por aplicação e deploy por Argo CD, em três stacks Terraform."
pubDate: 2026-11-22
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "aks", "argocd", "gitops", "postgresql", "private-link", "workload-identity", "platform-engineering", "azure"]
readingTime: "15 min"
heroImage: ../../../../assets/blog/arquitetura-aks-postgresql-privada.webp
lang: "pt"
draft: false
---

> **TL;DR**
> - Arquitetura de referência: uma aplicação em AKS com PostgreSQL dedicado, tudo em rede privada (cluster privado, subnet delegada, Private Endpoints e zonas Private DNS).
> - O Terraform entrega a rede, o cluster, o ACR, o banco, o Key Vault e a identidade da aplicação, em três stacks. O pod entra no cluster pelo **Argo CD**, a partir de manifestos em `infra/argocd`.
> - O pipeline só instala o Argo CD, uma vez por cluster. Depois disso, o deploy é um pull request.
> - O custo: agentes dentro da rede, um cluster que precisa alcançar o Git e uma ponte explícita entre o Terraform e os manifestos.
> - Esta é a **Parte 2 de 2**. A [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/) explica como dividir em stacks e acionar cada uma por parâmetro.

---

Na [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/) eu mostrei como dividir a infraestrutura em stacks e escolher o que rodar por parâmetro. Aqui está a arquitetura por trás dos exemplos: o que cada stack entrega, o código de cada uma e o deploy da aplicação por Argo CD. Os nomes (`vnet-core-prod-brs-01` e companhia) e os parâmetros vêm da Parte 1.

> **Como ler este artigo.** Todo link aponta para documentação oficial ou pesquisa publicada. Quando uma ideia é minha, e não da fonte, eu marco como **leitura minha**. O código é simplificado: adapte nomes, versões e permissões ao seu ambiente e teste em dev. **Atualização (22/11/2026):** revalidei o código com `terraform validate`, `actionlint`, `shellcheck` e `kustomize build` e corrigi o que não passava: resource group de cada stack, `location` e `resource_group_name` nas chamadas de módulo, o módulo de rede, o papel de rede do AKS, o atributo novo da credencial federada, o `kustomization.yaml` da base e o bootstrap, que agora só roda com `apply`.

---

## A arquitetura de referência

Para o exemplo não ficar abstrato, escolhi uma arquitetura que eu encontro com frequência: uma aplicação em **AKS** com um **PostgreSQL** dedicado a ela, tudo em rede privada. Os ícones são os oficiais da Microsoft ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), usados conforme os termos: sem alterar o formato e com o nome do produto junto ao ícone).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Arquitetura de referência em rede privada: usuários da rede corporativa entram por um ingress interno no cluster aks-core-prod-brs-01, dentro da subnet snet-aks, onde roda o pod orders. O pod acessa o PostgreSQL dedicado pgsql-orders-prod-brs-01, na subnet delegada snet-postgres, e, por Private Endpoints na snet-endpoints, o Key Vault. O cluster puxa imagens do Container Registry por outro Private Endpoint. O Argo CD, dentro do cluster, sincroniza os manifestos de um repositório Git com o pod. Agentes self-hosted na snet-agents executam o Terraform e o bootstrap do Argo CD. Zonas Private DNS vinculadas à VNet resolvem os nomes. Cada recurso está marcado com a stack Terraform dona dele: vnet-core-prod-brs-01, aks-core-prod-brs-01 ou app-orders-prod-brs-01." loading="lazy" />
    <figcaption>Figura 1 — Arquitetura de referência. As pílulas mostram a stack Terraform dona de cada recurso. O pod entra no cluster pelo Argo CD, a partir do Git, fora do Terraform. A fonte editável está em draw.io.</figcaption>
</figure>

O que a figura mostra, e a documentação por trás de cada decisão:

- **AKS como cluster privado.** Com `private_cluster_enabled`, o servidor de API recebe um IP interno e conversa com os nós por Azure Private Link ([docs](https://learn.microsoft.com/en-us/azure/aks/private-clusters)).
- **PostgreSQL com integração de rede (private access).** O servidor fica numa subnet **delegada**, de uso exclusivo dele, com no mínimo `/28`, e precisa de uma zona Private DNS terminada em `postgres.database.azure.com`. Via Terraform, você cria essas zonas, e o nome da zona não pode ser igual ao do servidor ([docs](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)).
- **ACR e Key Vault por Private Endpoint.** O private link do ACR exige o SKU **Premium** ([docs](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). O Key Vault usa o mesmo mecanismo ([docs](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)). Zonas DNS e subrecursos (`registry`, `vault`) estão na [tabela de zonas](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Agentes self-hosted na VNet.** O pipeline precisa alcançar a API do cluster (no bootstrap do Argo CD) e, se você fechar o acesso público, o registry e a conta do state. A doc do ACR avisa que, sem acesso público, o Azure DevOps Services deixa de acessá-lo, e a doc de [acesso a clusters privados](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) diz que o `az aks command invoke` não serve para acesso programático. Os agentes ficam fora das stacks deste exemplo (a `snet-agents` aparece tracejada).
- **Argo CD dentro do cluster, puxando do Git.** O [Argo CD](https://argo-cd.readthedocs.io/en/stable/) é um controller do Kubernetes que compara continuamente o estado vivo com o estado desejado, definido no Git. Como ele busca as mudanças no Git, o pipeline só precisa alcançar a API privada no bootstrap (**leitura minha** do modelo que a doc descreve). O preço está na figura: o cluster precisa alcançar o repositório Git.
- **Fora do escopo, de propósito:** o desenho de saída (egress) do cluster, que é uma decisão à parte com firewall ou NAT (o provider aceita `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` e `none` em `outbound_type`).

Os nomes seguem o padrão da [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/): `<tipo>-<nome>-<ambiente>-<região>-<seq>`, com `core` para a plataforma e `orders` para a aplicação. O nome do recurso também é o nome do state.

### Quem é dono de quê

A pergunta que define a divisão é "quem muda isso, e com que frequência". Para esta arquitetura:

| Stack (pasta) | Recursos | Módulos | `key` do state |
|---|---|---|---|
| `vnet-core` | Resource group, VNet, subnets, NSGs, zonas Private DNS | `network` | `vnet-core-prod-brs-01.tfstate` |
| `aks-core` | Resource group, AKS, ACR e o Private Endpoint dele | `aks`, `acr`, `private-endpoint` | `aks-core-prod-brs-01.tfstate` |
| `app-orders` | Resource group, PostgreSQL dedicado, Key Vault e o Private Endpoint dele, identidade da aplicação | `postgresql`, `key-vault`, `private-endpoint`, `workload-identity` | `app-orders-prod-brs-01.tfstate` |
| *(fora do Terraform)* | Argo CD (bootstrap) e o pod `orders` | Script de bootstrap e manifestos em `infra/argocd` | não tem state |

Três detalhes. O módulo `private-endpoint` é usado por duas stacks, e esse é o tipo de reaproveitamento que justifica um módulo: o guia de refatoração da HashiCorp recomenda agrupar em módulo o conjunto de recursos que você cria em várias configurações. E a stack `aks-core` também guarda o ACR: ela leva o nome do recurso principal, e o registry é apoio. Por fim, cada stack cria o próprio resource group (`rg-vnet-core-…`, `rg-aks-core-…`, `rg-app-orders-…`), e é por esse nome que as outras stacks e o script de bootstrap o encontram.

### Duas decisões de desenho

**O PostgreSQL é dedicado à aplicação e entra como uma chamada de módulo na stack dela.** Eu não crio um servidor compartilhado numa stack de "dados". A `orders` pede o banco dela do mesmo jeito que pede o Key Vault e a identidade, e o ciclo de vida do banco acompanha o da aplicação. Tamanho, SKU e storage são parâmetros da chamada. É uma escolha minha, com prós e contras:

- **Prós:** blast radius por aplicação, privilégio por aplicação, dimensionamento por aplicação e remoção completa quando ela sai.
- **Contras:** mais servidores para custear e operar (backup, patch, monitoramento). Se muitas aplicações pequenas têm o mesmo perfil de uso, um servidor compartilhado pode fazer mais sentido. Avalie com os números do seu ambiente.

**O pod entra no cluster pelo Argo CD, não pelo Terraform.** O critério é o da HashiCorp: agrupar por volatilidade e separar stateful de stateless. A aplicação muda várias vezes por dia e é stateless. O banco muda raramente e guarda dados. Se o pod fosse um recurso Terraform, cada nova versão da imagem passaria por `plan` e `apply` no mesmo state do banco. Com GitOps, a etapa mais frequente vira um commit nos manifestos, longe do state que menos pode errar. Essa aplicação da regra ao caso do Argo CD é **leitura minha**, porque a página da HashiCorp não fala de GitOps.

---

## As stacks e os módulos

Os trechos abaixo mostram as três stacks e os módulos da arquitetura. Todas recebem `environment` e `instance` (os parâmetros da [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/)) e derivam os nomes do mesmo sufixo (`prod-brs-01`). O backend e o `init` por stack também estão na Parte 1.

**`vnet-core`** chama o módulo `network` e é a dona da VNet, das subnets e das zonas DNS:

```hcl
# infra/stacks/vnet-core/main.tf (terraform {} e provider como no exemplo do backend da Parte 1)
variable "environment" { type = string } # prod
variable "instance" { type = string }    # brs-01
variable "location" { type = string }    # brazilsouth

locals {
  name   = "core"
  suffix = "${var.environment}-${var.instance}" # prod-brs-01
}

module "network" {
  source = "../../modules/network"

  location      = var.location
  name          = "vnet-${local.name}-${local.suffix}" # vnet-core-prod-brs-01
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

O módulo cria o resource group (`rg-vnet-core-prod-brs-01`) e recebe o mapa de subnets com um atributo opcional de delegação:

```hcl
# infra/modules/network/variables.tf (trecho)
variable "subnets" {
  type = map(object({
    cidr       = string
    delegation = optional(string)
  }))
}
```

O módulo cria o resource group, a VNet, as subnets (com a delegação, quando houver) e as zonas Private DNS, cada uma vinculada à VNet. Sem o vínculo, a VNet não resolve os nomes privados ([doc do PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)):

```hcl
# infra/modules/network/main.tf (trecho)
resource "azurerm_subnet" "this" {
  for_each             = var.subnets
  name                 = each.key
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [each.value.cidr]

  dynamic "delegation" {
    for_each = each.value.delegation == null ? [] : [each.value.delegation]
    content {
      name = "delegation"
      service_delegation {
        name    = delegation.value
        actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
      }
    }
  }
}

resource "azurerm_private_dns_zone" "this" {
  for_each            = toset(var.private_dns_zones)
  name                = each.value
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "this" {
  for_each              = azurerm_private_dns_zone.this
  name                  = "link-${var.name}"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = each.value.name
  virtual_network_id    = azurerm_virtual_network.this.id
}
```

**`aks-core`** não cria rede. Consulta a subnet e a zona do ACR que a `vnet-core` criou, e cria o registry, o endpoint privado e o cluster:

```hcl
# infra/stacks/aks-core/main.tf (continuação do bloco terraform/provider da seção do backend da Parte 1)
variable "environment" { type = string }
variable "instance" { type = string }
variable "location" { type = string }

locals {
  name       = "core"
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-core-${local.suffix}"
  vnet_name  = "vnet-core-${local.suffix}"
}

resource "azurerm_resource_group" "this" {
  name     = "rg-aks-${local.name}-${local.suffix}" # rg-aks-core-prod-brs-01
  location = var.location
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
  source = "../../modules/acr" # sku = "Premium", acesso público desabilitado

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  name                = "cr${local.name}${var.environment}${replace(var.instance, "-", "")}" # crcoreprodbrs01 (só letras e números)
}

module "acr_private_endpoint" {
  source = "../../modules/private-endpoint"

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  name                = "pep-cr-${local.name}-${local.suffix}" # pep-cr-core-prod-brs-01
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.acr.id
  subresource_name    = "registry"
  private_dns_zone_id = data.azurerm_private_dns_zone.acr.id
}

module "aks" {
  source = "../../modules/aks"

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  vm_size             = "Standard_D4ds_v5"
  node_count          = 3
  outbound_type       = "loadBalancer"                      # decisão de egress à parte
  name                = "aks-${local.name}-${local.suffix}" # aks-core-prod-brs-01
  subnet_id           = data.azurerm_subnet.aks.id
  acr_id              = module.acr.id
}
```

O que faz o cluster ser privado e usar Workload Identity está no módulo:

```hcl
# infra/modules/aks/main.tf (trecho)
resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = var.name

  private_cluster_enabled   = true
  oidc_issuer_enabled       = true
  workload_identity_enabled = true # exige oidc_issuer_enabled

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
    outbound_type       = var.outbound_type # decisão à parte, ver acima
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}

resource "azurerm_role_assignment" "subnet_network_contributor" {
  scope                = var.subnet_id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
}
```

O AKS usa uma subnet que não está no resource group dele, então a identidade do cluster precisa de `Network Contributor` nessa subnet ([doc de identidade gerenciada do AKS](https://learn.microsoft.com/en-us/azure/aks/system-assigned-managed-identity)). Com `SystemAssigned`, a atribuição só pode ser feita depois de o cluster existir. Se você quer o papel antes da criação, ou uma zona DNS privada própria para a API, use uma identidade `UserAssigned`.

**`app-orders`** é a stack da aplicação. O banco é uma chamada de módulo dedicada. Ela consulta a rede e as zonas DNS da `vnet-core` e o emissor OIDC do cluster da `aks-core`:

```hcl
# infra/stacks/app-orders/main.tf (terraform {} e provider como no exemplo do backend da Parte 1)
variable "environment" { type = string }
variable "instance" { type = string }
variable "location" { type = string }
variable "postgres_sku_name" { type = string }
variable "postgres_storage_mb" { type = number }

locals {
  suffix     = "${var.environment}-${var.instance}"
  network_rg = "rg-vnet-core-${local.suffix}"
  vnet_name  = "vnet-core-${local.suffix}"
}

resource "azurerm_resource_group" "this" {
  name     = "rg-app-orders-${local.suffix}" # rg-app-orders-prod-brs-01
  location = var.location
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

# Banco dedicado à aplicação orders
module "postgresql" {
  source = "../../modules/postgresql"

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  name                = "pgsql-orders-${local.suffix}" # pgsql-orders-prod-brs-01
  delegated_subnet_id = data.azurerm_subnet.postgres.id
  private_dns_zone_id = data.azurerm_private_dns_zone.postgres.id
  sku_name            = var.postgres_sku_name
  storage_mb          = var.postgres_storage_mb
}

module "key_vault" {
  source = "../../modules/key-vault"

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  name                = "kv-orders-${local.suffix}" # kv-orders-prod-brs-01
}

module "key_vault_private_endpoint" {
  source = "../../modules/private-endpoint"

  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  name                = "pep-kv-orders-${local.suffix}"
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.key_vault.id
  subresource_name    = "vault"
  private_dns_zone_id = data.azurerm_private_dns_zone.key_vault.id
}

module "workload_identity" {
  source = "../../modules/workload-identity"

  location             = var.location
  resource_group_name  = azurerm_resource_group.this.name
  name                 = "id-orders-${local.suffix}" # id-orders-prod-brs-01
  oidc_issuer_url      = data.azurerm_kubernetes_cluster.this.oidc_issuer_url
  namespace            = "orders"
  service_account_name = "orders"
  key_vault_id         = module.key_vault.id
}

output "postgres_fqdn" { value = module.postgresql.fqdn }
output "app_client_id" { value = module.workload_identity.client_id }
```

No módulo `postgresql`, o que importa para a rede privada é isto (o exemplo do [provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server) usa exatamente esses atributos):

```hcl
# infra/modules/postgresql/main.tf (trecho)
resource "azurerm_postgresql_flexible_server" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name

  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false

  sku_name   = var.sku_name
  storage_mb = var.storage_mb

  # versão, autenticação, backup...
}
```

O módulo `private-endpoint`, reaproveitado pelas stacks `aks-core` e `app-orders`:

```hcl
# infra/modules/private-endpoint/main.tf (trecho)
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

E o módulo `workload-identity`, que cria a identidade da aplicação e a federa com a conta de serviço do Kubernetes. A [documentação de Workload ID no AKS](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster) mostra os mesmos recursos, incluindo o papel `Key Vault Secrets User`:

```hcl
# infra/modules/workload-identity/main.tf (trecho)
resource "azurerm_user_assigned_identity" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_federated_identity_credential" "this" {
  name                      = "fic-${var.name}"
  user_assigned_identity_id = azurerm_user_assigned_identity.this.id
  issuer                    = var.oidc_issuer_url
  subject                   = "system:serviceaccount:${var.namespace}:${var.service_account_name}"
  audience                  = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}
```

A credencial federada usa `user_assigned_identity_id`, que substituiu `parent_id` no provider 4.65 (o `parent_id` será removido na 5.0; veja o [recurso no registry](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/federated_identity_credential)). O exemplo do Microsoft Learn ainda mostra o atributo antigo.

O Key Vault do exemplo usa RBAC (`rbac_authorization_enabled = true`) e `public_network_access_enabled = false`, atributos documentados do recurso [`azurerm_key_vault`](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault).

Se os módulos vivem em outro repositório, o `source` aponta para uma tag, para a versão ficar travada: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## O deploy da aplicação com Argo CD

Com a infraestrutura de pé, o pod `orders` entra no cluster pelo **Argo CD**, que a [documentação](https://argo-cd.readthedocs.io/en/stable/) descreve como uma ferramenta declarativa de entrega contínua GitOps para Kubernetes: o Git é a fonte da verdade do estado desejado, e um controller compara continuamente o estado vivo com ele. Os manifestos podem ser Kustomize, charts Helm ou um diretório de YAML.

Isso muda duas coisas no pipeline. O deploy da aplicação deixa de ser uma etapa dele e vira um commit no Git. E o pipeline só instala o Argo CD, uma vez por cluster (o **bootstrap**).

### O diretório `infra/argocd`

```text
infra/argocd/
├── bootstrap/
│   └── root-prod-brs-01.yaml        # Application raiz (app of apps), aplicada pelo pipeline
├── apps/
│   └── prod-brs-01/
│       └── orders.yaml              # Application da aplicação orders
└── manifests/
    └── orders/
        ├── base/                    # ServiceAccount, Deployment, Service...
        └── overlays/
            └── prod-brs-01/
                └── kustomization.yaml
```

- `bootstrap/` é o que o pipeline aplica uma vez: a Application raiz da instância.
- `apps/` tem uma Application por aplicação e por instância. A raiz enxerga esse diretório.
- `manifests/` tem o que cada Application sincroniza: uma base e um overlay por instância.

A raiz segue o padrão *app of apps* da [documentação de bootstrap de clusters](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/). A mesma página recomenda olhar os ApplicationSets na maioria dos cenários; escolhi app of apps por ser mais simples de mostrar. A doc usa um exemplo em Helm e diz que dá para usar outra ferramenta, então usei um diretório de manifestos (não executei esse formato exato).

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
    repoURL: https://github.com/<org>/<repo>.git   # ou o repositório no Azure Repos
    targetRevision: main
    path: infra/argocd/apps/prod-brs-01
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: {}      # sem prune: o padrão é não apagar o que saiu do Git
```

A Application da aplicação aponta para o overlay da instância. O formato é o de uma [Application mínima](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/), e o finalizer `resources-finalizer.argocd.argoproj.io` faz a remoção da Application apagar também o que ela gerencia (sem ele, a doc avisa que isso não acontece):

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
    # sem "automated": em prod a sincronização é manual, depois do merge do PR
```

`CreateNamespace=true` cria o namespace de destino se ele não existir ([sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)). No prod do exemplo não há `syncPolicy.automated`: o merge do pull request atualiza o Git, e a sincronização é manual. Em dev e hml eu usaria `automated`, que é opcional e, por padrão, [não apaga o que saiu do Git](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/).

Os manifestos ficam numa base, com o que é igual em todas as instâncias, e num overlay por instância. Como há um `kustomization.yaml` no caminho, o Argo CD renderiza com Kustomize ([doc](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)). Os dois nomes que a Workload Identity exige estão na [documentação do AKS](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster): a anotação `azure.workload.identity/client-id` na conta de serviço e o label `azure.workload.identity/use: "true"` nos pods.

```yaml
# infra/argocd/manifests/orders/base/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orders
  annotations:
    azure.workload.identity/client-id: "00000000-0000-0000-0000-000000000000"   # sobrescrito no overlay
```

```yaml
# infra/argocd/manifests/orders/base/deployment.yaml (trecho)
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

A base precisa do próprio `kustomization.yaml`, que lista o que ela contém. Sem ele, o `kustomize build` do overlay falha:

```yaml
# infra/argocd/manifests/orders/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - serviceaccount.yaml
  - deployment.yaml
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
      - DB_HOST=<postgres_fqdn>                  # output da stack app-orders

patches:
  - target:
      kind: ServiceAccount
      name: orders
    patch: |-
      - op: replace
        path: /metadata/annotations/azure.workload.identity~1client-id
        value: "<app_client_id>"                 # output da stack app-orders
```

O `subject` do módulo `workload-identity` (`system:serviceaccount:orders:orders`) tem de bater com o namespace da Application e o nome da conta de serviço. Os dois valores do overlay que vêm do Terraform (`app_client_id` e `postgres_fqdn`) são outputs da stack `app-orders`. Como eles chegam ao Git é decisão sua (copiar no PR que muda o Terraform, ou um passo que abre esse PR), mas a ponte precisa ser explícita. Nenhum segredo vai para o Git: a aplicação lê o Key Vault pela Workload Identity.

### O bootstrap

O script instala o Argo CD com o comando da [documentação de instalação](https://argo-cd.readthedocs.io/en/stable/getting_started/) e aplica a Application raiz da instância:

```bash
#!/usr/bin/env bash
# infra/scripts/bootstrap-argocd.sh  ->  bootstrap-argocd.sh <env> <instance>
set -euo pipefail

env="$1"; instance="$2"
suffix="${env}-${instance}"                       # prod-brs-01
argocd_version="v3.2.0"                           # fixe a versão; confira a atual

az aks get-credentials \
  --resource-group "rg-aks-core-${suffix}" \
  --name "aks-core-${suffix}" \
  --overwrite-existing

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n argocd --server-side --force-conflicts \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${argocd_version}/manifests/install.yaml"

kubectl apply -n argocd -f "infra/argocd/bootstrap/root-${suffix}.yaml"
```

- A doc usa `--server-side --force-conflicts` porque alguns CRDs (como o ApplicationSet) estouram o limite de tamanho da anotação do `kubectl apply` no cliente, e recomenda fixar a versão em produção. O `v3.2.0` é o exemplo da própria doc: confira a atual.
- O `az aks get-credentials` precisa de acesso de rede e DNS à API privada, por isso o bootstrap roda no agente self-hosted. O agente e o cluster também precisam alcançar a origem do `install.yaml` e das imagens, o que volta ao desenho de egress que deixei de fora.
- Se o repositório Git é privado, o Argo CD precisa de credenciais: a [doc](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/) lista HTTPS, SSH e GitHub App. Como provisioná-las eu não cobri.

### Estendendo o pipeline da Parte 1

O bootstrap entra no pipeline da [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/) como uma quarta etapa, que só roda quando a ação é `apply`. No Azure DevOps, acrescente o parâmetro e o stage ao orquestrador:

```yaml
# infra/pipelines/azure-pipelines.yml (acréscimos)
parameters:
  # ...
  - name: argocd
    displayName: "argocd · instalação e Application raiz (uma vez por cluster)"
    type: boolean
    default: false

stages:
  # ...
  - ${{ if and(eq(parameters.argocd, true), eq(parameters.action, 'apply')) }}:
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

O stage só entra quando a ação é `apply`: um run de `plan` não instala nada no cluster.

E o template do bootstrap, que usa o mesmo Environment (e, portanto, as mesmas aprovações), com uma service connection própria:

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
          name: agentes-privados
        environment: azure-${{ parameters.environment }}
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  displayName: instalar o Argo CD e a Application raiz
                  inputs:
                    azureSubscription: sc-aks-bootstrap-${{ parameters.environment }}
                    scriptType: bash
                    scriptLocation: scriptPath
                    scriptPath: infra/scripts/bootstrap-argocd.sh
                    arguments: ${{ parameters.environment }} ${{ parameters.instance }}
```

No GitHub Actions, acrescente o input e o job ao orquestrador:

```yaml
# .github/workflows/infra.yml (acréscimos)
on:
  workflow_dispatch:
    inputs:
      # ...
      argocd:
        description: "argocd · instalação e Application raiz (uma vez por cluster)"
        type: boolean
        default: false

jobs:
  # ...
  argocd:
    needs: [aks-core, app-orders]
    if: ${{ !cancelled() && !failure() && inputs.argocd && inputs.action == 'apply' }}
    uses: ./.github/workflows/argocd-bootstrap.yml
    with:
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
```

E o workflow reutilizável do bootstrap:

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
    runs-on: [self-hosted, linux, vnet-privada]   # precisa alcançar a API privada do AKS
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_BOOTSTRAP_CLIENT_ID }}   # identidade própria do bootstrap
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: instalar o Argo CD e a Application raiz
        run: bash ./infra/scripts/bootstrap-argocd.sh "${{ inputs.environment }}" "${{ inputs.instance }}"
```

O runner precisa ter `az` e `kubectl` instalados. O login usa a action `azure/login`, que é o fluxo da [documentação do GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure), e o `bootstrap-argocd.sh` é o mesmo script do Azure DevOps.

O bootstrap usa uma service connection (ou identidade federada) própria, separada da que roda o Terraform: quem aplica infraestrutura não precisa mexer em workloads, e quem instala o Argo CD não precisa criar rede.

### Como a aplicação muda depois disso

Uma nova versão da `orders` vira uma mudança no `newTag` do overlay, num pull request. O review desse PR é a aprovação do deploy, e a branch policy do repositório é o controle. No prod, o passo seguinte é a sincronização manual. Em nenhum momento o pipeline de infraestrutura entra em cena, nem precisa alcançar a API do cluster.

---

## Armadilhas que eu já vi acontecer

1. **A ponte entre Terraform e Git.** Se a Application da `orders` entra no Git antes de o banco e a identidade existirem, o pod sobe sem conseguir conectar: aplique a stack `app-orders` antes de mergear o PR que cria a Application. E se alguém recria o banco ou a identidade e esquece de atualizar o overlay, o Argo CD continua sincronizando os valores antigos, porque para ele o Git está certo.
2. **Rede privada também fecha a porta do seu pipeline.** Planeje o agente ou runner self-hosted dentro da VNet desde o começo. Com o Argo CD, o pipeline só precisa da API no bootstrap, mas o cluster passa a precisar sair para o Git.
3. **O Argo CD também tem armadilhas.** A doc avisa que o app of apps é uma capacidade de administrador: só admins devem ter push no repositório da Application pai, e os pull requests precisam de review, com atenção ao campo `project`. Proteja `infra/argocd/apps` com branch policy. E lembre que o sync automático só apaga o que saiu do Git se você habilitar o prune, e que, com o finalizer, apagar uma Application apaga o que ela gerencia. Decida isso de propósito, principalmente no prod.

---

## Prós, contras e quando eu não usaria

**Prós**

- Banco dedicado por aplicação, com o ciclo de vida da aplicação e blast radius próprio.
- Deploys frequentes por Git, longe do state que menos pode errar, e auditáveis: o histórico de commits e o review do PR são o registro e a aprovação.
- Rede privada de ponta a ponta, com identidade por Workload Identity e sem segredo no Git.

**Contras**

- Um banco por aplicação aumenta custo e operação.
- Mais um componente para operar (o Argo CD) e um cluster que precisa alcançar o Git.
- Rede privada exige agentes dentro da rede e um desenho de DNS cuidadoso.
- A ponte entre o Terraform e os manifestos é manual e precisa ser explícita.

**Quando eu não usaria.** Com poucas aplicações pequenas e perfil de uso parecido, um servidor de banco compartilhado e um deploy simples (Helm no pipeline) custam menos do que um banco por aplicação e o Argo CD. E, se o seu time não quer operar um controller dentro do cluster, o Argo CD não compensa.

---

## Checklist para começar

- [ ] Banco dedicado como chamada de módulo na stack da aplicação, se esse for o seu modelo
- [ ] Nomes de recursos globais (ACR, Key Vault) conferidos contra as regras de cada tipo
- [ ] Agentes ou runners self-hosted dentro da VNet, com acesso à API do cluster
- [ ] Desenho de saída (egress) do cluster definido
- [ ] Deploy por Argo CD, com manifestos em `infra/argocd` e uma Application por instância
- [ ] Aprovação do deploy de produção no pull request (branch policy) e, se preferir, sincronização manual
- [ ] `infra/argocd/apps` protegido com branch policy e reviewers
- [ ] Bootstrap do Argo CD pelo pipeline, uma vez por cluster, com identidade própria
- [ ] Credenciais do repositório Git configuradas no Argo CD, se ele for privado
- [ ] Ponte entre os outputs do Terraform e os manifestos documentada

---

## FAQ

**Por que Argo CD, e não deploy pelo pipeline ou pelo provider Helm do Terraform?**
Porque a aplicação muda muito mais do que o banco e a rede, e a regra de volatilidade da HashiCorp aponta para manter essa etapa fora do state da infraestrutura. O Argo CD também mantém o cluster reconciliado com o Git, e o pipeline não precisa alcançar a API privada a cada deploy. É uma escolha de desenho minha: se o seu time não quer operar o Argo CD, Helm no pipeline também funciona. E o Argo CD aceita charts Helm, Kustomize e diretórios de YAML ([doc](https://argo-cd.readthedocs.io/en/stable/)), então você pode manter charts no lugar do overlay.

**Por que o PostgreSQL usa subnet delegada e não Private Endpoint?**
Porque escolhi a integração de rede (private access). A [documentação](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) apresenta duas opções para o PostgreSQL Flexible Server: private access (o que usei) ou acesso público com Private Endpoint. Veja o que muda em cada uma antes de criar o servidor.

---

## Fechando

A arquitetura é só o contexto. O que importa continua sendo o desenho por baixo: quem é dono de quê, o que muda com que frequência e o que pode quebrar o quê. Com stacks separadas, banco por aplicação e deploy por Git, cada mudança cai no lugar certo e com o raio de impacto certo.

O desenho de saída (egress) do cluster e a ponte entre o Terraform e os manifestos são as duas partes que eu deixei mais em aberto aqui. Se você resolveu isso de um jeito bom, eu gostaria de saber como. E, se ainda não leu, a [Parte 1](/blog/pt-br/2026-11-21/parametros-no-pipeline-escolha-o-que-provisionar/) mostra como acionar cada stack por parâmetro.

---

## Referências

**Argo CD**
- [Visão geral](https://argo-cd.readthedocs.io/en/stable/)
- [Instalação (getting started)](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [Bootstrap de clusters (app of apps)](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
- [Configuração declarativa (Application)](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Sync automático](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [Sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)
- [Kustomize](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)
- [Repositórios privados](https://argo-cd.readthedocs.io/en/stable/user-guide/private-repositories/)

**Arquitetura de referência (rede privada)**
- [AKS — Clusters privados](https://learn.microsoft.com/en-us/azure/aks/private-clusters)
- [AKS — Acessar um cluster privado](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster)
- [AKS — Workload Identity: deploy e configuração](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster)
- [PostgreSQL Flexible Server — Rede com acesso privado](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
- [Azure Container Registry — Private Link](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)
- [Key Vault — Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)
- [Private Endpoint — Zonas DNS](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
- [Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)

**Terraform**
- [azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)
