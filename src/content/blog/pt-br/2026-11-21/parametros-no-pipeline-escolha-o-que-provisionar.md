---
title: "Parâmetros no pipeline: escolha o que provisionar (Terraform, vários tfstate e módulos)"
description: "Como usar parâmetros no YAML do Azure DevOps e do GitHub Actions para selecionar quais stacks Terraform rodam, por que separar o state e como isso fica numa arquitetura de referência com AKS e PostgreSQL em rede privada, com deploy por Helm."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modulos", "aks", "helm", "postgresql", "private-link", "platform-engineering", "azure"]
readingTime: "26 min"
lang: "pt"
draft: true
---

> **TL;DR**
> - Divida a infraestrutura em *stacks* independentes, cada uma com o seu `tfstate` e construída sobre módulos, e faça o pipeline receber parâmetros que dizem **o que rodar**, **onde** e **com qual ação**.
> - O ganho: blast radius menor, privilégio mínimo por stack, `plan` mais rápido e um único pipeline para manter.
> - Na arquitetura de referência (AKS e PostgreSQL em rede privada), o Terraform entrega a rede, o cluster e o banco dedicado da aplicação. A aplicação em si entra no cluster por **Helm ou manifestos**, em outra etapa do mesmo pipeline.
> - O mesmo desenho funciona no Azure DevOps (`parameters`) e no GitHub Actions (`workflow_dispatch` + `inputs`).
> - Cada argumento vem com a fonte (HashiCorp, Microsoft, DORA e outras). Onde a ligação é uma analogia minha, o texto avisa.
> - O custo: mais peças, e dependências entre stacks que passam a ser sua responsabilidade.

---

## O problema que me fez chegar nisso

Todo time de infraestrutura passa por uma fase parecida. Começa com um repositório Terraform, um `main.tf` e um pipeline que roda `terraform apply`. Funciona muito bem até o dia em que o arquivo cresce: rede, banco, cluster, Key Vault, monitoramento, tudo no mesmo state.

Aí aparecem os sintomas, e eu já vivi todos:

- Você só queria subir uma subnet nova, mas o `plan` leva 12 minutos porque aplica refresh em 600 recursos.
- Um diff inesperado no cluster aparece no plano de uma mudança que era só de rede.
- Duas pessoas precisam mexer em partes diferentes e uma fica esperando o lock da outra.
- O service principal do pipeline tem permissão para tudo, porque o state é um só e precisa enxergar tudo.
- Um erro humano num `apply` atinge o banco de dados junto com o resto.

A solução que eu uso hoje tem duas metades que andam juntas:

1. **Desenho:** a infraestrutura é dividida em *stacks* independentes, cada uma com o seu próprio `tfstate` e construída em cima de **módulos** reutilizáveis.
2. **Execução:** o pipeline recebe **parâmetros** que dizem *quais* stacks rodar, em *qual* ambiente e com *qual* ação.

Uma metade sem a outra não resolve. Parâmetro sem state separado vira um checkbox que não muda nada de verdade. State separado sem parâmetro vira um monte de pipelines duplicados para manter.

Um aviso antes de continuar: os trechos de código deste artigo são simplificados para explicar a ideia. Adapte nomes, versões e permissões ao seu ambiente e rode primeiro em dev.

---

## A ideia em uma imagem

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="Painel de parâmetros (ambiente, instância, ação e um checkbox por etapa) alimenta um pipeline único, que executa apenas as etapas marcadas: as stacks vnet-prod-brs-01 e aks-prod-brs-01. A stack da aplicação orders e o deploy com Helm estão desmarcados e não rodam. Cada stack grava em um tfstate próprio, nomeado como o recurso, no mesmo container do Azure Storage." loading="lazy" />
    <figcaption>Figura 1 — Os parâmetros escolhem o que roda. Cada stack tem o seu tfstate, então o que não foi selecionado nem é lido nem é alterado.</figcaption>
</figure>

O pipeline é um só. O que muda de um run para outro são os parâmetros. E como cada stack tem o seu state, "não rodar" uma stack é uma operação segura: ela simplesmente não participa.

---

## Por que isso importa

Eu não inventei nada disso, então cada argumento abaixo vem com a fonte. Onde a ligação com a fonte é uma analogia minha, e não uma conclusão do autor, eu aviso.

### 1. Blast radius menor

A própria HashiCorp diz, nas [boas práticas de workspaces](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices), que qualquer operação em um recurso pode afetar os outros recursos gerenciados no mesmo state, e que o ideal é manter o raio de impacto pequeno. A orientação é agrupar por volatilidade (o que muda sempre fica longe do que quase nunca muda), separar stateful de stateless (banco de dados longe de computação) e dividir por responsabilidade de times e privilégios. A página sugere até uma convenção de nome de workspace, `<unidade>-<app>-<camada>-<env>`, que é parente do padrão que uso aqui (`tipo-ambiente-região-seq`). Ela também avisa que planos e applies que demoram são um sinal precoce de escopo inchado.

O guia de [refatoração de state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) vai na mesma direção: recursos com cadências de atualização diferentes devem ser gerenciados separadamente para reduzir o blast radius de mudanças indesejadas.

Na prática: errar um `apply` na stack do cluster não coloca a rede nem o banco de dados na linha de tiro.

### 2. Menos privilégio

Com states separados, cada stack pode rodar com uma identidade diferente, com a permissão mínima de que ela precisa. A rede pede `Network Contributor` no escopo dela. A stack da aplicação pede outro conjunto. O pipeline que roda tudo com `Owner` na subscription deixa de ser necessário.

A HashiCorp coloca isso como uma recomendação explícita: dividir workspaces por responsabilidade de times e privilégios, porque, se o escopo é grande demais, alguém acaba precisando de mais permissão do que deveria. A mesma lógica aparece nas [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy): a landing zone de plataforma, com serviços centralizados, é separada das landing zones de workload. O que é compartilhado tem outro ciclo de vida e outro dono. A ligação com stacks de Terraform é uma analogia minha, mas a lógica de separação é a mesma.

### 3. Feedback mais rápido

`plan` menor, `apply` menor, lock menor. No backend `azurerm` o lock usa recursos nativos do Azure Blob Storage ([documentação do backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), e como cada stack é um blob com a sua `key`, ninguém espera ninguém. A [documentação da Microsoft](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend) descreve o mesmo comportamento.

### 4. Mudanças pequenas e frequentes

O Azure Well-Architected Framework, no item [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recomenda práticas de deploy seguras com foco em releases pequenos e incrementais, com quality gates e exposição progressiva. Também diz que todo deploy deve seguir um padrão e ser automatizado para reduzir o erro humano. A mesma página lembra que Azure Pipelines e GitHub Actions suportam deploys em vários estágios com approval gates. Selecionar só o que mudou é a versão de infraestrutura dessa ideia.

Aqui entra o DORA, com um cuidado: eu não estou dizendo que "parâmetros de pipeline" aparecem como um achado da pesquisa. O DORA hoje mede [cinco métricas de entrega](https://dora.dev/guides/dora-metrics/) (lead time da mudança, frequência de deploy, tempo de recuperação de deploy com falha, taxa de falha de mudança e taxa de retrabalho) e afirma que velocidade e estabilidade não são trade-offs. O argumento de que mudanças menores e mais isoladas ajudam nessas métricas é meu, e se apoia no que o relatório de [2024](https://dora.dev/research/2024/dora-report/) reforça: fundamentos como lotes pequenos e testes robustos continuam cruciais.

### 5. Um pipeline para manter, não dez

Em vez de `pipeline-vnet.yml`, `pipeline-aks.yml`, `pipeline-app.yml` com 90% de código igual, existe um template de stack e um orquestrador. Corrigiu um problema de autenticação uma vez, corrigiu para todas.

A capacidade [Deployment automation](https://dora.dev/capabilities/deployment-automation/) do DORA descreve exatamente esse formato: um processo de deploy automatizado que recebe os pacotes, os scripts e a configuração específica de cada ambiente, com scripts e configuração guardados em version control. E o [Twelve-Factor App](https://12factor.net/config) dá o critério para separar o que varia do que não varia: config é o que muda entre deploys (staging, produção, desenvolvimento) e fica separada do código, enquanto a "fiação" interna da aplicação, que não varia, fica no código. No nosso caso, ambiente e instância são config. A chamada de módulos dentro de cada stack é código.

---

## O exemplo: uma arquitetura de referência em rede privada

Para o exemplo não ficar abstrato, escolhi uma arquitetura que eu encontro com frequência: uma aplicação em **AKS** com um banco **PostgreSQL** dedicado a ela, tudo em rede privada. Os ícones são os oficiais da Microsoft ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), usados conforme os termos de uso: sem alterar o formato e com o nome do produto junto ao ícone).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Arquitetura de referência em rede privada: usuários da rede corporativa entram por um ingress interno no cluster aks-prod-brs-01, dentro da subnet snet-aks, onde roda o pod orders implantado por Helm. O pod acessa o PostgreSQL dedicado pgsql-orders-prod-brs-01, na subnet delegada snet-postgres, e, por Private Endpoints na snet-endpoints, o Key Vault. O cluster puxa imagens do Container Registry por outro Private Endpoint. Agentes self-hosted na snet-agents executam Terraform e Helm. Zonas Private DNS vinculadas à VNet resolvem os nomes. Cada recurso está marcado com a stack Terraform dona dele: vnet-prod-brs-01, aks-prod-brs-01 ou app-orders-prod-brs-01." loading="lazy" />
    <figcaption>Figura 2 — Arquitetura de referência. As pílulas mostram a stack Terraform dona de cada recurso. O pod entra no cluster por Helm, fora do Terraform. A fonte editável está em draw.io.</figcaption>
</figure>

O que a figura mostra, e o que cada decisão tem de documentação por trás:

- **AKS como cluster privado.** Com `private_cluster_enabled`, o servidor de API recebe um IP interno e se comunica com os nós por Azure Private Link, como descreve a [documentação de clusters privados do AKS](https://learn.microsoft.com/en-us/azure/aks/private-clusters).
- **PostgreSQL com integração de rede (private access).** O servidor fica numa subnet **delegada**, que só ele pode usar, com no mínimo `/28`, e precisa de uma zona Private DNS cujo nome termine em `postgres.database.azure.com`. A [documentação de rede do PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) também diz que, ao criar via Terraform, essas zonas precisam ser criadas por você, e que o nome da zona não pode ser igual ao do servidor.
- **Container Registry e Key Vault por Private Endpoint.** Para o ACR, o private link exige o SKU **Premium** ([doc do ACR](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). Para o Key Vault, a [doc de Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service) descreve o mesmo mecanismo. Os nomes das zonas DNS e dos subrecursos (`registry` e `vault`) estão na [tabela de zonas DNS de Private Endpoint](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Agentes self-hosted na própria VNet.** O pipeline precisa alcançar duas coisas privadas: o registry e a API do cluster. A doc do ACR avisa que, ao desabilitar o acesso público, instâncias de alguns serviços do Azure, incluindo o Azure DevOps Services, deixam de acessá-lo. E a doc de [acesso a clusters privados](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) diz que o `az aks command invoke` não serve para acesso programático: para chamadas automatizadas, ela indica Bastion, VPN ou ExpressRoute. Por isso a `snet-agents` aparece na figura, em tracejado: os agentes em si ficam fora das stacks deste exemplo.
- **Fora do escopo, de propósito.** O desenho de saída (egress) do cluster. O provider aceita `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` e `none` em `outbound_type`. É uma decisão à parte, com firewall ou NAT, e eu deixei de fora para não poluir o exemplo.

### Padrão de nomes

Eu nomeio tudo como `<tipo>-<ambiente>-<região>-<seq>`: `vnet-prod-brs-01`, `aks-prod-brs-01`. O tipo segue as [abreviações do Cloud Adoption Framework](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations) (`vnet`, `snet`, `aks`, `kv`, `rg`, `pep` para private endpoint, `pgsql` para PostgreSQL flexible server, `cr` para container registry e `id` para managed identity), e a ordem dos componentes é a que a Microsoft documenta em [definir a convenção de nomes](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming). O `brs` é o código curto de Brazil South do meu padrão, não um código da Microsoft.

Dois pontos dessa documentação pesam nas decisões: a maioria dos nomes não pode ser alterada depois de criada, então só entra no nome o que não muda (o resto vai em tag); e alguns nomes são globais e têm regras próprias. Segundo a [tabela de regras de nomes](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules), o Key Vault é global, com 3 a 24 caracteres, letras, números e hífens, e o ACR é global, com 5 a 50 caracteres e **só letras e números**. Por isso o registry do exemplo se chama `crprodbrs01`, sem hífens, e o Key Vault da aplicação, `kv-orders-prod-brs-01`.

O nome do recurso também é o nome do state: o `tfstate` da rede é `vnet-prod-brs-01.tfstate`. Quando alguém olha o container do state, cada blob diz exatamente o que ele guarda.

### Quem é dono de quê

A pergunta que define a divisão em stacks é "quem muda isso, e com que frequência". Para esta arquitetura, eu divido assim:

| Stack (pasta) | Recursos | Módulos | `key` do state |
|---|---|---|---|
| `vnet` | VNet, subnets, NSGs, zonas Private DNS | `network` | `vnet-prod-brs-01.tfstate` |
| `aks` | AKS, ACR e o Private Endpoint dele | `aks`, `acr`, `private-endpoint` | `aks-prod-brs-01.tfstate` |
| `app-orders` | PostgreSQL dedicado, Key Vault e o Private Endpoint dele, identidade da aplicação | `postgresql`, `key-vault`, `private-endpoint`, `workload-identity` | `app-orders-prod-brs-01.tfstate` |
| *(fora do Terraform)* | O pod `orders` no cluster | Helm chart ou manifestos | não tem state |

Repare em dois detalhes. O módulo `private-endpoint` é usado por duas stacks: esse é o tipo de reaproveitamento que justifica um módulo, e o guia de refatoração da HashiCorp recomenda agrupar em módulo o conjunto de recursos que você cria em várias configurações. E a stack `aks` também contém o ACR: ela leva o nome do recurso principal, e o registry é um recurso de apoio dela.

### O banco é da aplicação, e a aplicação não é do Terraform

Duas decisões desse desenho merecem justificativa.

**O PostgreSQL é dedicado à aplicação e entra como uma chamada de módulo dentro da stack dela.** Eu não crio um servidor de banco compartilhado numa stack de "dados". A aplicação `orders` pede o banco dela do mesmo jeito que pede o Key Vault e a identidade, e o ciclo de vida do banco acompanha o da aplicação. O tamanho, o SKU e o storage viram parâmetros da chamada do módulo, por aplicação. Isso é uma escolha minha, com prós e contras:

- **Prós:** blast radius por aplicação (um erro na stack `app-orders` não alcança o banco de outra aplicação), privilégio por aplicação, dimensionamento por aplicação e remoção completa quando a aplicação sai.
- **Contras:** mais servidores para custear e operar (backup, patch, monitoramento) e mais recursos na subnet delegada. Se muitas aplicações pequenas dividem o mesmo perfil de uso, um servidor compartilhado pode fazer mais sentido. Avalie com os números do seu ambiente.

**O pod entra no cluster por Helm ou manifestos, não por Terraform.** O critério é o mesmo da HashiCorp: agrupar por volatilidade e separar stateful de stateless. A aplicação muda várias vezes por dia e é stateless. O banco muda raramente e guarda dados. Se o pod fosse um recurso Terraform, cada nova versão da imagem passaria por `plan` e `apply` no mesmo state do banco. Mantendo o deploy em Helm, a etapa mais frequente do fluxo fica longe do estado que menos pode errar. Essa leitura da regra da HashiCorp para o caso do Helm é minha. A página não fala de Helm.

Na prática, o fluxo tem quatro etapas, nesta ordem: `vnet`, `aks`, `app-orders` e `helm`. O pipeline deixa você marcar qualquer subconjunto.

### Estrutura do repositório

```text
infra/
├── modules/                  # peças reutilizáveis, sem state próprio
│   ├── network/              # VNet, subnets, NSGs, zonas DNS privadas
│   ├── private-endpoint/     # reaproveitado por Key Vault e ACR
│   ├── postgresql/
│   ├── key-vault/
│   ├── workload-identity/
│   ├── acr/
│   └── aks/
├── stacks/                   # cada pasta é uma raiz Terraform = um tfstate por instância
│   ├── vnet/
│   ├── aks/
│   └── app-orders/
├── envs/
│   ├── dev-brs-01.tfvars
│   ├── hml-brs-01.tfvars
│   └── prod-brs-01.tfvars
├── scripts/
│   ├── tf.sh
│   └── deploy-app.sh
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/
        ├── terraform-stack.yml
        └── helm-deploy.yml
deploy/
└── orders/
    ├── chart/                # chart Helm (ou manifests/ para YAML puro)
    └── values-prod-brs-01.yaml
```

A regra que eu sigo:

- **Módulo** é o *como*: uma receita reutilizável de rede, de AKS, de banco. Fica direto em `modules/<recurso>`, com o nome do domínio (`network`, `aks`, `postgresql`) e nada de subpastas por equipe ou por projeto. Não tem backend nem state.
- **Stack** é o *o quê e onde*: uma raiz Terraform que chama módulos, tem backend próprio e é o que o pipeline executa. A pasta é por tipo (`vnet`, `aks`, `app-orders`). Cada **instância** (ambiente, região e sequência) é um state diferente da mesma pasta.
- **Instância** é só dado: um `.tfvars` e uma `key` diferente no backend. `prod-brs-01` e `dev-brs-01` rodam o mesmo código.

Aqui entra o Parnas. No artigo clássico [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) (CACM, 1972), o resumo diz que a eficácia de uma modularização depende do critério usado para dividir o sistema em módulos. É um artigo sobre software, não sobre IaC, então a ligação é uma analogia. Mas é a pergunta certa a fazer antes de criar pastas: dividir por quê? Eu divido por ciclo de vida e por dono, não por tamanho nem por tipo de recurso.

### O backend: um state por stack e por instância

Cada stack declara o backend vazio e recebe o resto na hora do `init` (é o que o Terraform chama de *partial configuration*):

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

E o `init` define a `key`, que no `azurerm` é o nome do blob dentro do container:

```bash
terraform init -input=false \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=sttfstatecorp001" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=aks-prod-brs-01.tfstate"
```

No fim, o container tem algo assim:

```text
tfstate/
├── vnet-dev-brs-01.tfstate
├── vnet-prod-brs-01.tfstate
├── aks-dev-brs-01.tfstate
├── aks-prod-brs-01.tfstate
├── app-orders-dev-brs-01.tfstate
└── app-orders-prod-brs-01.tfstate
```

Duas coisas que valem a atenção. A conta do state deve ficar fora do que o Terraform gerencia nas stacks, e a autenticação deve ser por Microsoft Entra ID e não por access key (a [documentação](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) marca o access key como "não recomendado para novas cargas" e indica `Storage Blob Data Contributor` no container como a opção de menor privilégio).

### As três stacks

Todas as stacks recebem duas variáveis, `environment` e `instance`, e derivam os nomes do mesmo sufixo.

**`vnet`** chama o módulo `network` e é a dona da VNet, das subnets e das zonas DNS:

```hcl
# infra/stacks/vnet/main.tf (terraform {} e provider como no exemplo do backend)
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

O módulo cria o resource group (`rg-vnet-prod-brs-01`) e recebe o mapa de subnets com um atributo opcional de delegação:

```hcl
# infra/modules/network/variables.tf (trecho)
variable "subnets" {
  type = map(object({
    cidr       = string
    delegation = optional(string)
  }))
}
```

**`aks`** não cria rede. Ela consulta a subnet e a zona do ACR que a stack `vnet` já criou, e cria o registry, o endpoint privado e o cluster:

```hcl
# infra/stacks/aks/main.tf (continuação do bloco terraform/provider acima)
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
  source = "../../modules/acr" # sku = "Premium", acesso público desabilitado

  name = "cr${var.environment}${replace(var.instance, "-", "")}"   # crprodbrs01 (só letras e números)
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

E o que faz o cluster ser privado e usar Workload Identity está no módulo:

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
```

**`app-orders`** é a stack da aplicação. Aqui o banco é uma chamada de módulo dedicada. Ela consulta a rede e as zonas DNS da `vnet`, e o emissor OIDC do cluster da `aks`:

```hcl
# infra/stacks/app-orders/main.tf (terraform {} e provider como no exemplo do backend)
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

# Banco dedicado à aplicação orders
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

No módulo `postgresql`, o que importa para a rede privada é isso (o exemplo do provider usa exatamente esses atributos):

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

Um detalhe que aparece na [documentação do provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server): o exemplo dela usa `depends_on` no link entre a zona DNS e a VNet. Na divisão em stacks, esse `depends_on` vira **ordem de execução**: a `vnet` roda antes. É exatamente o que o `dependsOn` do pipeline vai garantir mais adiante.

O módulo `private-endpoint`, reaproveitado pelas stacks `aks` e `app-orders`:

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

E o módulo `workload-identity`, que cria a identidade da aplicação e a federa com a conta de serviço do Kubernetes. A [documentação de Workload ID no AKS](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster) mostra os mesmos recursos, incluindo o papel `Key Vault Secrets User` para ler segredos:

```hcl
# infra/modules/workload-identity/main.tf (trecho)
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

O Key Vault do exemplo usa RBAC (`rbac_authorization_enabled = true`) e `public_network_access_enabled = false`, ambos atributos documentados do recurso `azurerm_key_vault`.

Repare que as stacks `aks` e `app-orders` **não leem o state de outra stack**. Elas consultam a rede e o cluster pela API do Azure com `data sources`. Isso é uma decisão consciente, e eu volto nela mais adiante.

Se os módulos vivem em outro repositório, o `source` aponta para uma tag, para a versão ficar travada: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## O deploy da aplicação: Helm ou manifestos

Com a infraestrutura de pé, o pod `orders` entra no cluster por Helm (ou por `kubectl apply` de manifestos, se você prefere YAML puro). A estrutura do que vai para o cluster fica em `deploy/orders/`, com o chart e um arquivo de values por instância:

```yaml
# deploy/orders/values-prod-brs-01.yaml
image:
  repository: crprodbrs01.azurecr.io/orders
  tag: "1.8.3"

serviceAccount:
  name: orders
  annotations:
    azure.workload.identity/client-id: "<app_client_id>"   # output da stack app-orders

podLabels:
  azure.workload.identity/use: "true"                      # o chart aplica nos pods

database:
  host: "<postgres_fqdn>"                                  # output da stack app-orders
  name: orders
```

Os dois nomes que a Workload Identity exige estão na [documentação do AKS](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster): a anotação `azure.workload.identity/client-id` na conta de serviço e o label `azure.workload.identity/use: "true"` nos pods. O `subject` do `workload-identity` acima (`system:serviceaccount:orders:orders`) tem de bater com o namespace e o nome da conta de serviço do chart.

O script de deploy é curto:

```bash
#!/usr/bin/env bash
# infra/scripts/deploy-app.sh  ->  deploy-app.sh <aplicação> <env> <instance>
set -euo pipefail

app="$1"; env="$2"; instance="$3"
suffix="${env}-${instance}"                       # prod-brs-01

az aks get-credentials \
  --resource-group "rg-aks-${suffix}" \
  --name "aks-${suffix}" \
  --overwrite-existing

helm upgrade --install "${app}" "deploy/${app}/chart" \
  --namespace "${app}" --create-namespace \
  --values "deploy/${app}/values-${suffix}.yaml" \
  --rollback-on-failure \
  --timeout 5m

# Se preferir manifestos em vez de Helm:
# kubectl apply -n "${app}" -f "deploy/${app}/manifests/"
```

Alguns pontos importantes:

- A flag `--rollback-on-failure` é a que a [página atual do `helm upgrade`](https://helm.sh/docs/helm/helm_upgrade/) documenta: se a atualização falhar, o Helm volta para a última release bem-sucedida. Em versões mais antigas do Helm, a flag equivalente era `--atomic`. Confirme na versão que você usa.
- O `az aks get-credentials` depende de o agente alcançar a API privada do cluster. É por isso que o pool do pipeline é self-hosted dentro da VNet (ver Figura 2). A documentação de [acesso a clusters privados](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) diz que o cliente precisa de acesso de rede e de DNS ao endpoint privado, a partir da VNet do cluster ou de uma rede conectada.
- Se o cluster exigir autenticação do Entra ID no `kubectl`, o kubeconfig pode precisar de um passo extra de login. Eu não verifiquei esse detalhe, então confira a documentação do AKS para a sua configuração.
- Os dois valores que vêm do Terraform (`app_client_id` e `postgres_fqdn`) são outputs da stack `app-orders`. Como entram no values do Helm é decisão sua: gravar no arquivo de values no pull request que muda o Terraform, ou ler os outputs no pipeline antes do `helm upgrade`. O importante é que a ponte entre as duas etapas seja explícita.
- Use uma identidade própria para o deploy, diferente da que roda o Terraform. A que aplica infraestrutura não precisa mexer em workloads, e a que implanta a aplicação não precisa criar rede.

---

## Azure DevOps: parâmetros em tempo de execução

O Azure Pipelines tem [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): você declara o parâmetro com tipo, valor padrão e, se quiser, uma lista de valores permitidos, e a tela de **Run pipeline** monta o formulário para você. Para o que a gente quer, três tipos resolvem: `string` com `values` (vira lista de opções), `boolean` (vira checkbox) e `object` (para estruturas mais ricas). Existe ainda o `stringList`, que permite marcar vários itens, mas a documentação avisa que ele não está disponível em templates (nos templates, use `object`). Mostro essa variação logo abaixo.

### O orquestrador

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # execução sempre intencional; ver "armadilhas" mais abaixo

parameters:
  - name: environment
    displayName: Ambiente
    type: string
    default: dev
    values: [dev, hml, prod]

  - name: instance
    displayName: Instância (região-seq)
    type: string
    default: brs-01
    values: [brs-01]          # novas instâncias (outra região, outro stamp) entram aqui

  - name: action
    displayName: Ação
    type: string
    default: plan
    values: [plan, apply]

  - name: vnet
    displayName: "vnet · rede privada"
    type: boolean
    default: false

  - name: aks
    displayName: "aks · cluster e ACR"
    type: boolean
    default: false

  - name: appOrders
    displayName: "app-orders · PostgreSQL dedicado, Key Vault e identidade"
    type: boolean
    default: false

  - name: helm
    displayName: "helm · deploy da aplicação orders"
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

  - ${{ if eq(parameters.helm, true) }}:
      - template: templates/helm-deploy.yml
        parameters:
          stageName: helm
          application: orders
          environment: ${{ parameters.environment }}
          instance: ${{ parameters.instance }}
          dependsOn:
            - ${{ if eq(parameters.aks, true) }}:
                - aks
            - ${{ if eq(parameters.appOrders, true) }}:
                - app_orders
```

O ponto central está nas expressões `${{ if ... }}`. Elas são **expressões de template**, avaliadas quando o pipeline é montado (a documentação de [template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) explica que elas são resolvidas na inicialização). Quer dizer: o stage da etapa desmarcada **não existe** no run. Não aparece "skipped", não consome agente, simplesmente não está lá.

Os `dependsOn` condicionais resolvem um detalhe chato: se você declarar dependência de um stage que não foi incluído, o pipeline falha na validação. Aqui cada dependência só existe quando a etapa correspondente foi selecionada, e a lista fica vazia quando nenhuma foi. É a tradução, em pipeline, daquele `depends_on` que a documentação do provider usa dentro de uma stack única. Eu não executei esse formato específico de lista condicional, mas ele usa a inserção condicional em sequências que a [documentação de template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) descreve.

### Variação: uma lista de múltipla escolha

Em vez de um booleano por etapa, dá para usar um `stringList` no pipeline principal, em que a tela de execução permite marcar vários itens de uma vez:

```yaml
parameters:
  - name: stacks
    displayName: Etapas a executar
    type: stringList
    values: [vnet, aks, app-orders, helm]
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

A documentação mostra essa iteração com `each` sobre um `stringList`. Evitei o `contains` porque, segundo a [referência de expressões](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions), ele compara strings; para arrays existe o `containsValue`, mas a própria página o descreve como de uso limitado fora de pipeline decorators. Eu não executei este exemplo, então valide antes de adotar. Com essa forma, os `dependsOn` condicionais do exemplo principal tendem a ficar mais trabalhosos.

### O template de stack

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
          name: agentes-privados   # self-hosted, dentro da VNet (ver Figura 2)
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
              name: agentes-privados
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

E o template do deploy com Helm, que usa o mesmo Environment (e, portanto, as mesmas aprovações) e uma service connection própria:

```yaml
# infra/pipelines/templates/helm-deploy.yml
parameters:
  - name: stageName
    type: string
  - name: application
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
    displayName: "helm · ${{ parameters.application }}-${{ parameters.environment }}-${{ parameters.instance }}"
    dependsOn: ${{ parameters.dependsOn }}
    jobs:
      - deployment: deploy
        pool:
          name: agentes-privados
        environment: azure-${{ parameters.environment }}
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  displayName: helm upgrade --install
                  inputs:
                    azureSubscription: sc-aks-deploy-${{ parameters.environment }}
                    scriptType: bash
                    scriptLocation: scriptPath
                    scriptPath: infra/scripts/deploy-app.sh
                    arguments: ${{ parameters.application }} ${{ parameters.environment }} ${{ parameters.instance }}
```

O que está acontecendo:

- Uma **service connection por ambiente** para o Terraform (`sc-terraform-dev`, `sc-terraform-prod`) e outra para o deploy da aplicação (`sc-aks-deploy-prod`), idealmente com federação de identidade. Nada de segredo guardado.
- O pool é `agentes-privados`, um pool self-hosted dentro da VNet. Num ambiente em que o ACR (e, se você também fechar, a conta do state) não aceita acesso público, o agente hospedado pela Microsoft não alcança esses recursos, e a API do cluster é privada.
- Os jobs `deployment` usam um **Environment** do Azure DevOps. É nele que você configura as aprovações e checks do `prod`. Quem aprova o `apply` e o deploy em produção é decisão do Environment, não do YAML. Segundo a [documentação](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), aprovações e checks não são definidos no YAML e quem edita o YAML não consegue alterá-los; quem administra o recurso (Environment, service connection etc.) os gerencia pela interface.
- O `plan` é publicado como artefato e o `apply` aplica **aquele** plano. É o que foi revisado que vai ser aplicado, e não um plano novo calculado depois da aprovação.

### O script que os dois passos usam

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
export ARM_CLIENT_ID="$servicePrincipalId"   # expostos pela task AzureCLI@2
export ARM_TENANT_ID="$tenantId"
export ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID="$AZURESUBSCRIPTION_SERVICE_CONNECTION_ID"  # exigido pelo provider no Azure DevOps
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

Os valores `TFSTATE_RG` e `TFSTATE_SA` podem vir de variáveis do pipeline. A task [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) expõe `$servicePrincipalId` e `$tenantId` (e o `idToken`) no ambiente do script quando `addSpnToEnvironment: true` e a service connection usa federação de identidade. Para o backend, a [documentação do `azurerm`](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) diz que, no Azure DevOps, os endpoints do token OIDC são encontrados automaticamente e que, com `AzureCLI@2` ou `AzurePowerShell`, o ID da service connection já vem na variável `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID`. Por isso o script não passa o token manualmente. Para o *provider*, o [guia de OIDC do `azurerm`](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) diz que, no Azure DevOps, ele usa `ARM_OIDC_REQUEST_TOKEN` e `ARM_OIDC_REQUEST_URL` ou, na ausência deles, cai em `SYSTEM_ACCESSTOKEN` e `SYSTEM_OIDCREQUESTURI`, e exige o ID da service connection em `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. É por isso que o `env:` das tasks passa o `System.AccessToken` e o `System.OidcRequestUri`, e que o script reaproveita o `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` (essa reutilização é minha: o guia usa uma variável própria com o ID da conexão). O guia também recomenda a `AzureCLI@2` em vez da `TerraformTaskV4`, que depende de uma extensão que não vem instalada por padrão, e informa que o suporte a OIDC no provider começa na versão 3.7.0.

---

## GitHub Actions: o mesmo desenho

No GitHub, o equivalente dos parâmetros é o `workflow_dispatch` com `inputs`. Os tipos suportados são `string`, `choice`, `boolean` e `environment` (e o `number`), como o [changelog de input types](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows) descreve. O `environment` é interessante: ele lista os Environments do repositório como opções. Um detalhe de limite: desde dezembro de 2025 o `workflow_dispatch` aceita [até 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/); antes eram 10.

### O orquestrador

```yaml
# .github/workflows/infra.yml
name: infra

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Ambiente (Environment do GitHub)
        type: environment
        required: true
      instance:
        description: Instância (região-seq)
        type: choice
        options: [brs-01]
        default: brs-01
      action:
        description: Ação
        type: choice
        options: [plan, apply]
        default: plan
      vnet:
        description: "vnet · rede privada"
        type: boolean
        default: false
      aks:
        description: "aks · cluster e ACR"
        type: boolean
        default: false
      app_orders:
        description: "app-orders · PostgreSQL dedicado, Key Vault e identidade"
        type: boolean
        default: false
      helm:
        description: "helm · deploy da aplicação orders"
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

  helm:
    needs: [aks, app-orders]
    if: ${{ !cancelled() && !failure() && inputs.helm }}
    uses: ./.github/workflows/helm-deploy.yml
    with:
      application: orders
      environment: ${{ inputs.environment }}
      instance: ${{ inputs.instance }}
```

Aqui tem uma diferença importante em relação ao Azure DevOps. No GitHub a condição é avaliada **em tempo de execução**, então o job desmarcado aparece como *skipped*. E, segundo a [documentação](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), se um job falha ou é pulado, todos os que dependem dele também são pulados, a menos que usem uma expressão condicional que os faça continuar. O `!cancelled() && !failure()` resolve isso: "rode se nada falhou, mesmo que a dependência tenha sido pulada". Outro detalhe: o contexto `inputs` preserva booleanos, enquanto `github.event.inputs` converte tudo em string; por isso uso `inputs.vnet` direto no `if`.

### O workflow reutilizável do Terraform

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
    runs-on: [self-hosted, linux, vnet-privada]   # runner dentro da VNet (ver Figura 2)
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

### O workflow reutilizável do deploy com Helm

```yaml
# .github/workflows/helm-deploy.yml
name: helm-deploy

on:
  workflow_call:
    inputs:
      application: { type: string, required: true }
      environment: { type: string, required: true }
      instance:    { type: string, required: true }

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: [self-hosted, linux, vnet-privada]   # precisa alcançar a API privada do AKS
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_DEPLOY_CLIENT_ID }}   # identidade própria do deploy
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: helm upgrade --install
        run: ./infra/scripts/deploy-app.sh "${{ inputs.application }}" "${{ inputs.environment }}" "${{ inputs.instance }}"
```

O runner precisa ter `az`, `helm` (e `kubectl`, se você usa manifestos) instalados. O login usa a action `azure/login`, que é o fluxo que a [documentação do GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) mostra, e o `deploy-app.sh` é o mesmo script do Azure DevOps.

Os pontos que fazem diferença:

- Os [workflows reutilizáveis](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) são chamados no nível do job, recebem `inputs` com `with`, e o tipo precisa bater com o declarado (booleano, número ou string). A documentação permite encadear até dez níveis de workflows (o chamador mais nove). Um detalhe que serve ao nosso desenho: o job que chama o reutilizável não pode usar `environment`; quem declara o `environment` é o job dentro do reutilizável, como fizemos.
- No Terraform, a autenticação é por **OIDC**. O `ARM_USE_OIDC` faz o provider pedir o token ao GitHub e trocar por acesso no Azure, sem nenhum segredo armazenado. Aqui deixei o próprio Terraform fazer a troca: segundo o [guia de OIDC do provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc), no GitHub Actions ele detecta sozinho `ACTIONS_ID_TOKEN_REQUEST_URL` e `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, desde que o workflow tenha `id-token: write`. O mesmo guia lembra que a credencial federada é por Environment, branch, pull request ou tag, e que os valores precisam bater exatamente.
- Quando o job usa um Environment, o *subject* do token fica no formato `repo:ORG/REPO:environment:NOME`. Isso permite criar **uma credencial federada por ambiente** no Entra ID: o `prod` só aceita tokens de jobs do Environment `prod`. É privilégio mínimo e separação por ambiente praticamente de graça. Atenção a uma mudança recente: segundo a [referência de OIDC do GitHub](https://docs.github.com/en/actions/reference/security/oidc), repositórios criados depois de 15/07/2026 (e renomeados ou transferidos depois dessa data) usam por padrão um subject imutável, que inclui os IDs do dono e do repositório, enquanto os antigos mantêm o formato por nome até você optar. A [Microsoft recomenda migrar](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) as credenciais baseadas em nome. Ou seja, a credencial federada precisa bater com o formato do seu repositório. A referência traz o exemplo do subject por ambiente (`repo:octo-org/octo-repo:environment:Production`) e, para o formato imutável, o exemplo com branch (`repo:octo-org@123456/octo-repo@456789:ref:refs/heads/main`), então confirme como fica o subject de ambiente no seu caso. A documentação ainda recomenda proteger o Environment com regras (por exemplo, restringir branches e tags) quando ele é usado em políticas OIDC.
- Neste exemplo, `plan` e `apply` rodam no mesmo job, aplicando o plano salvo. O custo é que, se o Environment tiver *required reviewers*, a aprovação é pedida **antes** do plan. Se isso incomoda, use dois Environments (`dev-plan` e `dev-apply`, por exemplo) ou separe em dois jobs.
- O `runs-on` aponta para um runner self-hosted dentro da VNet, pelo mesmo motivo do pool do Azure DevOps: a rede é privada. Os labels `self-hosted, linux, vnet-privada` são do exemplo; use os do seu ambiente.

---

## Comparando os dois

| Ponto | Azure DevOps | GitHub Actions |
|---|---|---|
| Parâmetro do run | `parameters` com `type` e `values` | `workflow_dispatch.inputs` (`choice`, `boolean`, `environment`, `string`) |
| Quando a seleção é aplicada | Montagem do pipeline: o stage nem existe | Execução: o job aparece como skipped |
| Aprovação | Environment com approvals e checks | Environment com required reviewers |
| Reuso | Templates (`template:`) | Workflows reutilizáveis (`workflow_call`) |
| Autenticação | Service connection com federação | OIDC com credencial federada por Environment |
| Limite que me pegou | Parâmetros precisam de `default`; num run disparado por trigger valem os defaults | 25 inputs por `workflow_dispatch`; até 10 níveis de workflows encadeados |

Nenhum é melhor em tudo. A diferença de "stage inexistente versus job skipped" parece detalhe, mas muda como você lê o histórico de execuções e como configura dependências.

---

## Por que não um state só, com `-target`?

Eu já vi quem tentasse o caminho oposto: um state só, e parâmetro passando `-target=module.aks`. Não recomendo como rotina. A própria [documentação do Terraform](https://developer.hashicorp.com/terraform/cli/commands/plan) diz para usar `-target` apenas em circunstâncias excepcionais (como se recuperar de erros) e que não é recomendado para operações de rotina. Ele não resolve o lock, o tempo de refresh, o blast radius no state nem a separação de permissões. É o checkbox sem a metade do desenho.

---

## Entre stacks: `terraform_remote_state` ou data source?

Quando uma stack depende de outra, tem duas formas de ler a informação. No exemplo, `aks` e `app-orders` precisam da subnet e das zonas DNS da `vnet`, e `app-orders` precisa do emissor OIDC do cluster:

- `terraform_remote_state`: lê os outputs do state da outra stack. É direto, mas quem lê precisa de acesso ao arquivo de state inteiro (que pode conter dados sensíveis) e você acopla uma stack ao formato do state da outra.
- **Data source do provider**: consulta o recurso real pela API do Azure. Exige uma convenção de nomes (o padrão `tipo-ambiente-região-seq` faz esse papel), mas dá um acoplamento mais fraco e não precisa liberar acesso a state alheio. No caso do emissor OIDC, o data source `azurerm_kubernetes_cluster` expõe o atributo `oidc_issuer_url`.

A HashiCorp não proíbe compartilhar outputs: nas boas práticas de workspaces ela recomenda expor só os outputs necessários a outros workspaces (via `tfe_outputs`), justamente para reduzir o risco de vazar informação sensível do state. Eu prefiro o data source por padrão e uso o `remote_state` quando preciso de um output que não existe como recurso consultável. Essa preferência é minha, baseada em experiência, não uma regra da HashiCorp, então avalie no seu contexto.

Sobre acoplamento, vale o paralelo com a capacidade [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) do DORA, que afirma que, em arquiteturas fortemente acopladas, pequenas mudanças podem causar falhas em cascata. Ela fala de arquitetura de software e de times, então a ligação com IaC é uma analogia, mas o raciocínio é o mesmo: quanto menos uma stack sabe sobre os detalhes internos da outra, menos uma mudança se espalha.

---

## Armadilhas que eu já vi acontecer

1. **Parâmetro não é cofre.** A Microsoft avisa que os valores dos parâmetros são expandidos na montagem do template e podem aparecer em logs. Segredo não vai em parâmetro. A pesquisa [*The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) (Rahman, Parnin e Williams, ICSE 2019) analisou 15.232 scripts de IaC e encontrou 21.201 ocorrências de *security smells*, 1.326 delas senhas hardcoded, e mostrou que um segredo hardcoded pode persistir por até 98 meses (mediana de 20), então não conte com "depois a gente tira". A documentação do Azure DevOps também manda validar e restringir os valores permitidos dos parâmetros, aplicar privilégio mínimo e guardar credenciais em variáveis secretas, Key Vault ou variable groups.
2. **Seleção parcial gera drift.** Se alguém marca só a etapa do cluster depois de uma mudança de rede que não foi aplicada, o plano vai falhar ou, pior, ser aplicado sobre uma base desatualizada. Eu resolvo com `plan` como ação padrão e com uma rotina agendada que roda `plan` em tudo para detectar drift.
3. **Ordem de execução e de destruição.** Na criação, a ordem é `vnet`, `aks`, `app-orders` e `helm`. No `destroy` é o inverso, e o banco guarda dados. Por isso eu simplesmente não ofereço `destroy` como valor de `action` em `prod`.
4. **Helm antes do banco.** Marcar só a etapa `helm` num ambiente em que o banco ou a identidade ainda não existem faz o pod subir sem conseguir conectar. O `dependsOn` protege quando as etapas vêm no mesmo run. Num run só de `helm`, quem protege é o seu critério (e, se quiser, um check no Environment).
5. **Values do Helm desatualizados.** O `app_client_id` e o `postgres_fqdn` vêm do Terraform. Se alguém recria o banco ou a identidade e esquece de atualizar o values, o deploy sobe com valores velhos. Trate a ponte entre Terraform e Helm como parte do desenho, não como detalhe.
6. **Quem pode clicar em "Run" é parte do controle de acesso.** O formulário de parâmetros é uma interface de controle de infraestrutura. Restrinja quem pode executar o pipeline e proteja o Environment de produção.
7. **Dividir demais.** Vinte states pequenos viram vinte pontos de dependência. Divida por ciclo de vida e por dono, não por tamanho. É o critério do Parnas, de novo.
8. **Execuções por trigger usam o default.** Se você ligar o pipeline a um `trigger`, o run automático usa os valores padrão dos parâmetros. Por isso o `trigger: none` no exemplo e o `default: false` nas etapas.
9. **Rede privada também fecha a porta do seu pipeline.** Com o ACR sem acesso público, o agente hospedado pela Microsoft deixa de alcançá-lo, como a doc do ACR avisa, e a API do cluster só responde dentro da rede. Planeje o agente ou runner self-hosted dentro da VNet desde o começo. Se você também fechar o acesso público da conta do state, o mesmo vale para o `terraform init`.

---

## Prós e contras

**Prós**

- Blast radius menor e mudanças mais fáceis de revisar.
- Permissão mínima por stack, por ambiente e por aplicação.
- Planos mais rápidos e sem disputa de lock.
- Um único pipeline para manter, com o mesmo código em todas as instâncias.
- Módulos reaproveitados entre stacks (o `private-endpoint` do exemplo).
- Banco dedicado por aplicação, com ciclo de vida junto da aplicação.
- Deploy frequente da aplicação separado do state que menos pode errar.
- Histórico claro: o run registra o que foi selecionado, e o nome do state diz o que ele guarda.

**Contras**

- Mais peças para entender: módulos, stacks, backends, templates, charts.
- Dependências entre stacks ficam explícitas e precisam ser gerenciadas por você, incluindo a ponte Terraform → Helm.
- Migrar de um state grande exige planejamento (o [guia de refatoração](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) da HashiCorp manda rodar `terraform plan` na configuração de origem e confirmar que ele não vai alterar nada).
- A seleção manual abre espaço para erro humano se você não colocar guard rails (approvals, valores permitidos, `plan` como padrão).
- Um banco por aplicação aumenta custo e operação.
- Divisão errada troca um problema por outro: acoplamento entre states.
- Rede privada exige agentes dentro da rede e um desenho de DNS cuidadoso.

---

## Checklist para começar

- [ ] Mapear recursos por ciclo de vida, dono e stateful/stateless antes de dividir
- [ ] Definir o padrão de nomes (`tipo-ambiente-região-seq`) antes do primeiro `apply`, porque a maioria dos nomes não muda depois
- [ ] Extrair módulos para o que se repete, com nome de domínio direto em `modules/<recurso>`
- [ ] Uma stack por raiz Terraform, com `backend "azurerm" {}` vazio
- [ ] `key` = `<stack>-<ambiente>-<região>-<seq>.tfstate`
- [ ] Autenticação por federação de identidade, sem segredo
- [ ] Parâmetros: `environment` e `instance` com lista fechada, `action` com `plan` como padrão, um booleano por etapa
- [ ] Aprovação no Environment de produção, para o Terraform e para o Helm
- [ ] `plan` salvo e aplicado como artefato
- [ ] Banco dedicado como chamada de módulo na stack da aplicação, se esse for o seu modelo
- [ ] Deploy da aplicação por Helm ou manifestos, fora do state, com identidade própria
- [ ] Agentes ou runners self-hosted dentro da VNet, se a rede é privada
- [ ] Rotina agendada de `plan` para detectar drift
- [ ] Documentar a ordem de dependência entre as etapas

---

## FAQ

**Posso usar `object` em vez de vários booleanos no Azure DevOps?**
Pode, e dá para iterar com `${{ each }}`, o que reduz o YAML. O custo é que a entrada fica menos amigável que checkboxes e é mais fácil errar. Se quiser um meio-termo, veja a variação com `stringList` acima. Para poucas etapas, eu prefiro booleanos.

**E se eu quiser rodar todas as etapas de uma vez?**
Marque todas. Se isso for o caso mais comum, considere um parâmetro `all` ou um perfil de execução, mas mantenha a seleção individual disponível.

**Por que não implantar o pod com o provider Helm do Terraform?**
É possível, e eu não estou dizendo que está errado. Eu prefiro Helm no pipeline porque a aplicação muda com muito mais frequência do que o banco e a rede, e a regra de agrupar por volatilidade da HashiCorp aponta para manter essa etapa fora do state da infraestrutura. É uma escolha de desenho minha. Se o seu time faz poucos deploys e quer tudo no mesmo plano, o caminho do Terraform também funciona.

**Por que o PostgreSQL usa subnet delegada e não Private Endpoint?**
Porque escolhi a integração de rede (private access). A [documentação](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) apresenta duas opções de rede para o PostgreSQL Flexible Server: private access (integração com a VNet, o que usei) ou acesso público com Private Endpoint. Veja o que muda em cada uma antes de criar o servidor.

**Isso funciona com Bicep ou OpenTofu?**
O desenho de parâmetros, stacks independentes e pipeline único serve para qualquer IaC. O que é específico do Terraform aqui é o `tfstate` e o backend. O OpenTofu usa o mesmo modelo de backend `azurerm`; confirme as particularidades na documentação dele.

**Como migro de um state único?**
Planeje o agrupamento, mova os recursos com blocos `removed` e `import` (o guia de refatoração da HashiCorp detalha), e confirme que `terraform plan` não mostra mudanças em nenhuma das stacks. Faça primeiro em dev.

**Preciso de Terraform Cloud para isso?**
Não. O que eu mostrei usa backend `azurerm` e o pipeline. Terraform Cloud tem o conceito de workspaces que resolve parte disso de outro jeito.

---

## Fechando

A parte que mais me convenceu foi perceber que o checkbox no pipeline é só a ponta visível. O que sustenta a ideia é o desenho por baixo: módulos que concentram o *como*, stacks que isolam o *o quê*, states que isolam o *impacto*, nomes que dizem o que cada coisa é e identidades que isolam o *quem pode*. Com isso pronto, o parâmetro vira só a forma de escolher.

Se você só tem um state hoje, não precisa dividir tudo de uma vez. Comece pelo que muda com mais frequência ou pelo que seria mais doloroso de quebrar, normalmente rede e dados, e ande daí.

---

## Referências

**Documentação oficial**
- [Azure Pipelines — Runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters)
- [Azure Pipelines — Template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)
- [Azure Pipelines — Template parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-parameters)
- [Azure Pipelines — Expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions)
- [Azure Pipelines — Approvals e checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
- [Azure Pipelines — Task AzureCLI@2](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2)
- [GitHub — Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub — Referência de OIDC](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch agora aceita 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — OIDC no Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — Subjects imutáveis do GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — terraform plan e `-target`](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [HashiCorp — Backend azurerm](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Terraform azurerm — Guia de OIDC](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)
- [Terraform azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [Terraform azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [Terraform azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)
- [Helm — helm upgrade](https://helm.sh/docs/helm/helm_upgrade/)

**Arquitetura de referência (rede privada)**
- [AKS — Clusters privados](https://learn.microsoft.com/en-us/azure/aks/private-clusters)
- [AKS — Acessar um cluster privado](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster)
- [AKS — Workload Identity: deploy e configuração](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster)
- [PostgreSQL Flexible Server — Rede com acesso privado](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
- [Azure Container Registry — Private Link](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)
- [Key Vault — Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)
- [Private Endpoint — Zonas DNS](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
- [Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)

**Nomes e padrões**
- [Cloud Adoption Framework — Abreviações de recursos](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations)
- [Cloud Adoption Framework — Definir a convenção de nomes](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Azure — Regras e restrições de nomes de recursos](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules)
- [Azure Well-Architected — Safe deployment practices (OE:11)](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments)
- [Azure Landing Zones — Deploy](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy)
- [The Twelve-Factor App — III. Config](https://12factor.net/config)

**Pesquisa**
- D. L. Parnas, [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623), Communications of the ACM, 15(12), 1972.
- A. Rahman, C. Parnin, L. Williams, [*The Seven Sins: Security Smells in Infrastructure as Code Scripts*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts), ICSE 2019.
- [DORA — Software delivery performance metrics](https://dora.dev/guides/dora-metrics/)
- [DORA — Deployment automation](https://dora.dev/capabilities/deployment-automation/)
- [DORA — Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/)
- [Accelerate State of DevOps 2024 (DORA)](https://dora.dev/research/2024/dora-report/)
