---
title: "Parâmetros no pipeline: escolha o que provisionar (Terraform, vários tfstate e módulos)"
description: "Como usar parâmetros no YAML do Azure DevOps e do GitHub Actions para selecionar quais stacks Terraform rodam, por que separar o state e como isso fica numa arquitetura real com AKS e PostgreSQL em rede privada."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modulos", "aks", "postgresql", "private-link", "platform-engineering", "azure"]
readingTime: "22 min"
lang: "pt"
draft: true
---

> **TL;DR**
> - Divida a infraestrutura em *stacks* independentes, cada uma com o seu `tfstate` e construída sobre módulos, e faça o pipeline receber parâmetros que dizem **o que rodar**, **onde** e **com qual ação**.
> - O ganho: blast radius menor, privilégio mínimo por stack, `plan` mais rápido e um único pipeline para manter.
> - O mesmo desenho funciona no Azure DevOps (`parameters`) e no GitHub Actions (`workflow_dispatch` + `inputs`). O exemplo usa uma arquitetura real: AKS e PostgreSQL em rede privada.
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
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="Painel de parâmetros (ambiente, ação e um checkbox por stack) alimenta um pipeline único, que executa apenas as stacks marcadas. Cada stack grava em um tfstate próprio no mesmo container do Azure Storage; a stack de dados está desmarcada e não é executada." loading="lazy" />
    <figcaption>Figura 1 — Os parâmetros escolhem quais stacks rodam. Cada stack tem o seu tfstate, então o que não foi selecionado nem é lido nem é alterado.</figcaption>
</figure>

O pipeline é um só. O que muda de um run para outro são os parâmetros. E como cada stack tem o seu state, "não rodar" uma stack é uma operação segura: ela simplesmente não participa.

---

## Por que isso importa

Eu não inventei nada disso, então cada argumento abaixo vem com a fonte. Onde a ligação com a fonte é uma analogia minha, e não uma conclusão do autor, eu aviso.

### 1. Blast radius menor

A própria HashiCorp diz, nas [boas práticas de workspaces](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices), que qualquer operação em um recurso pode afetar os outros recursos gerenciados no mesmo state, e que o ideal é manter o raio de impacto pequeno. A orientação é agrupar por volatilidade (o que muda sempre fica longe do que quase nunca muda), separar stateful de stateless (banco de dados longe de computação) e dividir por responsabilidade de times e privilégios. A página sugere até uma convenção de nome de workspace, `<unidade>-<app>-<camada>-<env>`, que lembra bastante o `10-network/dev` que uso aqui. Ela também avisa que planos e applies que demoram são um sinal precoce de escopo inchado.

O guia de [refatoração de state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) vai na mesma direção: recursos com cadências de atualização diferentes devem ser gerenciados separadamente para reduzir o blast radius de mudanças indesejadas.

Na prática: errar um `apply` na stack do cluster não coloca a rede nem o banco de dados na linha de tiro.

### 2. Menos privilégio

Com states separados, cada stack pode rodar com uma identidade diferente, com a permissão mínima de que ela precisa. A rede pede `Network Contributor` no escopo dela. A stack de dados pede outro conjunto. O pipeline que roda tudo com `Owner` na subscription deixa de ser necessário.

A HashiCorp coloca isso como uma recomendação explícita: dividir workspaces por responsabilidade de times e privilégios, porque, se o escopo é grande demais, alguém acaba precisando de mais permissão do que deveria. A mesma lógica aparece nas [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy): a landing zone de plataforma, com serviços centralizados, é separada das landing zones de workload. O que é compartilhado tem outro ciclo de vida e outro dono. A ligação com stacks de Terraform é uma analogia minha, mas a lógica de separação é a mesma.

### 3. Feedback mais rápido

`plan` menor, `apply` menor, lock menor. No backend `azurerm` o lock usa recursos nativos do Azure Blob Storage ([documentação do backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), e como cada stack é um blob com a sua `key`, ninguém espera ninguém. A [documentação da Microsoft](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend) descreve o mesmo comportamento.

### 4. Mudanças pequenas e frequentes

O Azure Well-Architected Framework, no item [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recomenda práticas de deploy seguras com foco em releases pequenos e incrementais, com quality gates e exposição progressiva. Também diz que todo deploy deve seguir um padrão e ser automatizado para reduzir o erro humano. A mesma página lembra que Azure Pipelines e GitHub Actions suportam deploys em vários estágios com approval gates. Selecionar só o que mudou é a versão de infraestrutura dessa ideia.

Aqui entra o DORA, com um cuidado: eu não estou dizendo que "parâmetros de pipeline" aparecem como um achado da pesquisa. O DORA hoje mede [cinco métricas de entrega](https://dora.dev/guides/dora-metrics/) (lead time da mudança, frequência de deploy, tempo de recuperação de deploy com falha, taxa de falha de mudança e taxa de retrabalho) e afirma que velocidade e estabilidade não são trade-offs. O argumento de que mudanças menores e mais isoladas ajudam nessas métricas é meu, e se apoia no que o relatório de [2024](https://dora.dev/research/2024/dora-report/) reforça: fundamentos como lotes pequenos e testes robustos continuam cruciais.

### 5. Um pipeline para manter, não dez

Em vez de `pipeline-network.yml`, `pipeline-data.yml`, `pipeline-aks.yml` com 90% de código igual, existe um template de stack e um orquestrador. Corrigiu um problema de autenticação uma vez, corrigiu para todas.

A capacidade [Deployment automation](https://dora.dev/capabilities/deployment-automation/) do DORA descreve exatamente esse formato: um processo de deploy automatizado que recebe os pacotes, os scripts e a configuração específica de cada ambiente, com scripts e configuração guardados em version control. E o [Twelve-Factor App](https://12factor.net/config) dá o critério para separar o que varia do que não varia: config é o que muda entre deploys (staging, produção, desenvolvimento) e fica separada do código, enquanto a "fiação" interna da aplicação, que não varia, fica no código. No nosso caso, ambiente e seleção de stack são config. A chamada de módulos dentro de cada stack é código.

---

## O exemplo: uma aplicação cloud native em rede privada

Para o exemplo não ficar abstrato, escolhi uma arquitetura que eu encontro com frequência: uma aplicação em **AKS** com um banco **PostgreSQL**, tudo em rede privada. Os ícones são os oficiais da Microsoft ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), usados conforme os termos de uso: sem alterar o formato e com o nome do produto junto ao ícone).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Arquitetura em rede privada: usuários da rede corporativa entram por um ingress interno no AKS, dentro da snet-aks. O AKS acessa o PostgreSQL Flexible Server na subnet delegada snet-postgres e, por Private Endpoints na snet-endpoints, o Container Registry e o Key Vault. Zonas Private DNS vinculadas à VNet resolvem os nomes. Cada recurso está marcado com a stack Terraform dona dele: 10-network, 20-data ou 30-aks." loading="lazy" />
    <figcaption>Figura 2 — Arquitetura de exemplo. As pílulas mostram a stack dona de cada recurso: 10-network, 20-data ou 30-aks. A fonte editável está em draw.io.</figcaption>
</figure>

O que a figura mostra, e o que cada decisão tem de documentação por trás:

- **AKS como cluster privado.** Com `private_cluster_enabled`, o servidor de API recebe um IP interno e se comunica com os nós por Azure Private Link, como descreve a [documentação de clusters privados do AKS](https://learn.microsoft.com/en-us/azure/aks/private-clusters).
- **PostgreSQL com integração de rede (private access).** O servidor fica numa subnet **delegada**, que só ele pode usar, com no mínimo `/28`, e precisa de uma zona Private DNS cujo nome termine em `postgres.database.azure.com`. A [documentação de rede do PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) também diz que, ao criar via Terraform, essas zonas precisam ser criadas por você, e que o nome da zona não pode ser igual ao do servidor.
- **Container Registry e Key Vault por Private Endpoint.** Para o ACR, o private link exige o SKU **Premium** ([doc do ACR](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). Para o Key Vault, a [doc de Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service) descreve o mesmo mecanismo. Os nomes das zonas DNS e dos subrecursos (`registry` e `vault`) estão na [tabela de zonas DNS de Private Endpoint](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Agentes self-hosted na própria VNet.** A doc do ACR avisa que, ao desabilitar o acesso público, instâncias de alguns serviços do Azure, incluindo o Azure DevOps Services, deixam de acessar o registry. Num ambiente fechado, o pipeline precisa rodar de dentro da rede. Por isso a `snet-agents` aparece na figura, em tracejado: os agentes em si ficam fora das stacks deste exemplo.
- **Fora do escopo, de propósito.** O desenho de saída (egress) do cluster. O provider aceita `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` e `none` em `outbound_type`. É uma decisão à parte, com firewall ou NAT, e eu deixei de fora para não poluir o exemplo.

### Quem é dono de quê

A pergunta que define a divisão em stacks é "quem muda isso, e com que frequência". Para esta arquitetura, eu divido assim:

| Stack | Recursos | Módulos | `key` do state |
|---|---|---|---|
| `10-network` | VNet, subnets, NSGs, zonas Private DNS | `network` | `10-network/<env>.tfstate` |
| `20-data` | PostgreSQL Flexible Server, Key Vault e o Private Endpoint dele | `postgresql`, `key-vault`, `private-endpoint` | `20-data/<env>.tfstate` |
| `30-aks` | AKS, ACR e o Private Endpoint dele | `aks`, `acr`, `private-endpoint` | `30-aks/<env>.tfstate` |

Repare que o módulo `private-endpoint` é usado por duas stacks. Esse é o tipo de reaproveitamento que justifica um módulo: o guia de refatoração da HashiCorp recomenda agrupar em módulo o conjunto de recursos que você cria em várias configurações.

### Estrutura do repositório

```text
infra/
├── modules/                  # peças reutilizáveis, sem state próprio
│   ├── network/              # VNet, subnets, NSGs, zonas DNS privadas
│   ├── private-endpoint/     # reaproveitado por Key Vault e ACR
│   ├── postgresql/
│   ├── key-vault/
│   ├── acr/
│   └── aks/
├── stacks/                   # cada pasta é uma raiz Terraform = um tfstate
│   ├── 10-network/
│   ├── 20-data/
│   └── 30-aks/
├── envs/
│   ├── dev.tfvars
│   ├── hml.tfvars
│   └── prd.tfvars
├── scripts/
│   └── tf.sh
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/terraform-stack.yml
```

A regra que eu sigo:

- **Módulo** é o *como*: uma receita reutilizável de rede, de AKS, de banco. Fica direto em `modules/<recurso>`, com o nome do domínio (`network`, `aks`, `postgresql`) e nada de subpastas por equipe ou por projeto. Não tem backend nem state.
- **Stack** é o *o quê e onde*: uma raiz Terraform que chama módulos, tem backend próprio e é o que o pipeline executa.
- **Ambiente** é só dado: um `.tfvars` e uma `key` diferente no backend.

Aqui entra o Parnas. No artigo clássico [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) (CACM, 1972), o resumo diz que a eficácia de uma modularização depende do critério usado para dividir o sistema em módulos. É um artigo sobre software, não sobre IaC, então a ligação é uma analogia. Mas é a pergunta certa a fazer antes de criar pastas: dividir por quê? Eu divido por ciclo de vida e por dono, não por tamanho nem por tipo de recurso.

O prefixo numérico (`10-`, `20-`, `30-`) é só convenção para a ordem de dependência ficar visível.

### O backend: uma key por stack e por ambiente

Cada stack declara o backend vazio e recebe o resto na hora do `init` (é o que o Terraform chama de *partial configuration*):

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

E o `init` define a `key`, que no `azurerm` é o nome do blob dentro do container:

```bash
terraform init -input=false \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=sttfstatecorp001" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=30-aks/dev.tfstate"
```

No fim, o container tem algo assim:

```text
tfstate/
├── 10-network/dev.tfstate
├── 10-network/prd.tfstate
├── 20-data/dev.tfstate
├── 20-data/prd.tfstate
├── 30-aks/dev.tfstate
└── 30-aks/prd.tfstate
```

Duas coisas que valem a atenção. A conta do state deve ficar fora do que o Terraform gerencia nas stacks, e a autenticação deve ser por Microsoft Entra ID e não por access key (a [documentação](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) marca o access key como "não recomendado para novas cargas" e indica `Storage Blob Data Contributor` no container como a opção de menor privilégio).

### As três stacks

**`10-network`** chama o módulo `network` e é a dona da VNet, das subnets e das zonas DNS:

```hcl
# infra/stacks/10-network/main.tf (terraform {} e provider como no exemplo do backend)
variable "environment" { type = string }
variable "workload"    { type = string }

module "network" {
  source = "../../modules/network"

  environment   = var.environment
  workload      = var.workload
  address_space = ["10.10.0.0/16"]

  subnets = {
    aks       = { cidr = "10.10.0.0/22" }
    endpoints = { cidr = "10.10.4.0/27" }
    postgres  = { cidr = "10.10.4.32/28", delegation = "Microsoft.DBforPostgreSQL/flexibleServers" }
    agents    = { cidr = "10.10.4.64/27" }
  }

  private_dns_zones = [
    "privatelink.azurecr.io",
    "privatelink.vaultcore.azure.net",
    "${var.workload}-${var.environment}.postgres.database.azure.com",
  ]
}
```

O módulo recebe o mapa de subnets com um atributo opcional de delegação:

```hcl
# infra/modules/network/variables.tf (trecho)
variable "subnets" {
  type = map(object({
    cidr       = string
    delegation = optional(string)
  }))
}
```

**`20-data`** não cria rede. Ela consulta a subnet e as zonas DNS que a stack de rede já criou:

```hcl
# infra/stacks/20-data/main.tf (terraform {} e provider como no exemplo do backend)
variable "environment" { type = string }
variable "workload"    { type = string }

locals {
  network_rg = "rg-network-${var.workload}-${var.environment}"
  vnet_name  = "vnet-${var.workload}-${var.environment}"
}

data "azurerm_subnet" "postgres" {
  name                 = "snet-postgres-${var.environment}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_subnet" "endpoints" {
  name                 = "snet-endpoints-${var.environment}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_private_dns_zone" "postgres" {
  name                = "${var.workload}-${var.environment}.postgres.database.azure.com"
  resource_group_name = local.network_rg
}

data "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = local.network_rg
}

module "postgresql" {
  source = "../../modules/postgresql"

  environment         = var.environment
  workload            = var.workload
  delegated_subnet_id = data.azurerm_subnet.postgres.id
  private_dns_zone_id = data.azurerm_private_dns_zone.postgres.id
}

module "key_vault" {
  source = "../../modules/key-vault"

  environment = var.environment
  workload    = var.workload
}

module "key_vault_private_endpoint" {
  source = "../../modules/private-endpoint"

  name                = "pe-kv-${var.workload}-${var.environment}"
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.key_vault.id
  subresource_name    = "vault"
  private_dns_zone_id = data.azurerm_private_dns_zone.key_vault.id
}
```

No módulo `postgresql`, o que importa para a rede privada é isso (o exemplo do provider usa exatamente esses atributos):

```hcl
# infra/modules/postgresql/main.tf (trecho)
resource "azurerm_postgresql_flexible_server" "this" {
  name                = "psql-${var.workload}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name

  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false

  # versão, SKU, storage, autenticação...
}
```

Um detalhe que aparece na [documentação do provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server): o exemplo dela usa `depends_on` no link entre a zona DNS e a VNet. Na divisão em stacks, esse `depends_on` vira **ordem de execução**: a `10-network` roda antes. É exatamente o que o `dependsOn` do pipeline vai garantir mais adiante.

E o módulo reaproveitado, o `private-endpoint`:

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

**`30-aks`** segue o mesmo padrão: consulta a subnet e a zona do ACR, cria o registry, o endpoint privado e o cluster.

```hcl
# infra/stacks/30-aks/main.tf (continuação do bloco terraform/provider acima)
variable "environment" { type = string }
variable "workload"    { type = string }

locals {
  network_rg = "rg-network-${var.workload}-${var.environment}"
  vnet_name  = "vnet-${var.workload}-${var.environment}"
}

data "azurerm_subnet" "aks" {
  name                 = "snet-aks-${var.environment}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_subnet" "endpoints" {
  name                 = "snet-endpoints-${var.environment}"
  virtual_network_name = local.vnet_name
  resource_group_name  = local.network_rg
}

data "azurerm_private_dns_zone" "acr" {
  name                = "privatelink.azurecr.io"
  resource_group_name = local.network_rg
}

module "acr" {
  source = "../../modules/acr" # sku = "Premium", acesso público desabilitado

  environment = var.environment
  workload    = var.workload
}

module "acr_private_endpoint" {
  source = "../../modules/private-endpoint"

  name                = "pe-acr-${var.workload}-${var.environment}"
  subnet_id           = data.azurerm_subnet.endpoints.id
  target_resource_id  = module.acr.id
  subresource_name    = "registry"
  private_dns_zone_id = data.azurerm_private_dns_zone.acr.id
}

module "aks" {
  source = "../../modules/aks"

  environment = var.environment
  workload    = var.workload
  subnet_id   = data.azurerm_subnet.aks.id
  acr_id      = module.acr.id
}
```

E o que faz o cluster ser privado e usar Workload Identity está no módulo:

```hcl
# infra/modules/aks/main.tf (trecho)
resource "azurerm_kubernetes_cluster" "this" {
  name                = "aks-${var.workload}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = "aks-${var.workload}-${var.environment}"

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

Repare que as stacks `20-data` e `30-aks` **não leem o state da stack de rede**. Elas consultam a rede pela API do Azure com `data sources`. Isso é uma decisão consciente, e eu volto nela mais adiante.

Se os módulos vivem em outro repositório, o `source` aponta para uma tag, para a versão ficar travada: `git::https://.../modules.git//aks?ref=v1.4.0`.

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
    values: [dev, hml, prd]

  - name: action
    displayName: Ação
    type: string
    default: plan
    values: [plan, apply]

  - name: network
    displayName: "10 · Rede"
    type: boolean
    default: false

  - name: data
    displayName: "20 · Dados (PostgreSQL, Key Vault)"
    type: boolean
    default: false

  - name: aks
    displayName: "30 · AKS e ACR"
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

O ponto central está nas expressões `${{ if ... }}`. Elas são **expressões de template**, avaliadas quando o pipeline é montado (a documentação de [template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) explica que elas são resolvidas na inicialização). Quer dizer: o stage da stack desmarcada **não existe** no run. Não aparece "skipped", não consome agente, simplesmente não está lá.

O `dependsOn` condicional resolve um detalhe chato: se você declarar dependência de um stage que não foi incluído, o pipeline falha na validação. Aqui a dependência só existe quando a stack de rede também foi selecionada. É a tradução, em pipeline, daquele `depends_on` que a documentação do provider usa dentro de uma stack única.

### Variação: uma lista de múltipla escolha

Em vez de um booleano por stack, dá para usar um `stringList` no pipeline principal, em que a tela de execução permite marcar vários itens de uma vez:

```yaml
parameters:
  - name: stacks
    displayName: Stacks a provisionar
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

A documentação mostra essa iteração com `each` sobre um `stringList`. Evitei o `contains` porque, segundo a [referência de expressões](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/expressions), ele compara strings; para arrays existe o `containsValue`, mas a própria página o descreve como de uso limitado fora de pipeline decorators. Eu não executei este exemplo, então valide antes de adotar. Com essa forma, o `dependsOn` condicional do exemplo principal tende a ficar mais trabalhoso.

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
          name: agentes-privados   # self-hosted, dentro da VNet (ver Figura 2)
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
                        arguments: apply ${{ parameters.stack }} ${{ parameters.environment }}
                        addSpnToEnvironment: true
                      env:
                        SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                        SYSTEM_OIDCREQUESTURI: $(System.OidcRequestUri)
```

O que está acontecendo:

- Uma **service connection por ambiente** (`sc-terraform-dev`, `sc-terraform-prd`), idealmente com federação de identidade. Nada de segredo guardado.
- O pool é `agentes-privados`, um pool self-hosted dentro da VNet. Num ambiente em que o ACR (e, se você também fechar, a conta do state) não aceita acesso público, o agente hospedado pela Microsoft não alcança esses recursos.
- O job `deployment` usa um **Environment** do Azure DevOps. É nele que você configura as aprovações e checks do `prd`. Quem aprova o `apply` de produção é decisão do Environment, não do YAML. Segundo a [documentação](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), aprovações e checks não são definidos no YAML e quem edita o YAML não consegue alterá-los; quem administra o recurso (Environment, service connection etc.) os gerencia pela interface.
- O `plan` é publicado como artefato e o `apply` aplica **aquele** plano. É o que foi revisado que vai ser aplicado, e não um plano novo calculado depois da aprovação.

### O script que os dois passos usam

```bash
#!/usr/bin/env bash
# infra/scripts/tf.sh  ->  tf.sh <plan|apply> <stack> <env>
set -euo pipefail

cmd="$1"; stack="$2"; env="$3"
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
        description: Ambiente
        type: environment
        required: true
      action:
        description: Ação
        type: choice
        options: [plan, apply]
        default: plan
      network:
        description: "10 · Rede"
        type: boolean
        default: false
      data:
        description: "20 · Dados (PostgreSQL, Key Vault)"
        type: boolean
        default: false
      aks:
        description: "30 · AKS e ACR"
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

Aqui tem uma diferença importante em relação ao Azure DevOps. No GitHub a condição é avaliada **em tempo de execução**, então o job desmarcado aparece como *skipped*. E, segundo a [documentação](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), se um job falha ou é pulado, todos os que dependem dele também são pulados, a menos que usem uma expressão condicional que os faça continuar. O `!cancelled() && !failure()` resolve isso: "rode se nada falhou, mesmo que a dependência tenha sido pulada". Outro detalhe: o contexto `inputs` preserva booleanos, enquanto `github.event.inputs` converte tudo em string; por isso uso `inputs.network` direto no `if`.

### O workflow reutilizável

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

Os pontos que fazem diferença:

- Os [workflows reutilizáveis](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) são chamados no nível do job, recebem `inputs` com `with`, e o tipo precisa bater com o declarado (booleano, número ou string). A documentação permite encadear até dez níveis de workflows (o chamador mais nove). Um detalhe que serve ao nosso desenho: o job que chama o reutilizável não pode usar `environment`; quem declara o `environment` é o job dentro do reutilizável, como fizemos.
- A autenticação é por **OIDC**. O `ARM_USE_OIDC` faz o provider pedir o token ao GitHub e trocar por acesso no Azure, sem nenhum segredo armazenado. A [documentação do GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) mostra o fluxo com a action `azure/login`. Aqui deixei o próprio Terraform fazer a troca: segundo o [guia de OIDC do provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc), no GitHub Actions ele detecta sozinho `ACTIONS_ID_TOKEN_REQUEST_URL` e `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, desde que o workflow tenha `id-token: write`. O mesmo guia lembra que a credencial federada é por Environment, branch, pull request ou tag, e que os valores precisam bater exatamente. Se preferir o caminho mais trilhado, faça o login com `azure/login` antes.
- Quando o job usa um Environment, o *subject* do token fica no formato `repo:ORG/REPO:environment:NOME`. Isso permite criar **uma credencial federada por ambiente** no Entra ID: o `prd` só aceita tokens de jobs do Environment `prd`. É privilégio mínimo e separação por ambiente praticamente de graça. Atenção a uma mudança recente: segundo a [referência de OIDC do GitHub](https://docs.github.com/en/actions/reference/security/oidc), repositórios criados depois de 15/07/2026 (e renomeados ou transferidos depois dessa data) usam por padrão um subject imutável, que inclui os IDs do dono e do repositório, enquanto os antigos mantêm o formato por nome até você optar. A [Microsoft recomenda migrar](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) as credenciais baseadas em nome. Ou seja, a credencial federada precisa bater com o formato do seu repositório. A referência traz o exemplo do subject por ambiente (`repo:octo-org/octo-repo:environment:Production`) e, para o formato imutável, o exemplo com branch (`repo:octo-org@123456/octo-repo@456789:ref:refs/heads/main`), então confirme como fica o subject de ambiente no seu caso. A documentação ainda recomenda proteger o Environment com regras (por exemplo, restringir branches e tags) quando ele é usado em políticas OIDC.
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

Quando uma stack depende de outra, tem duas formas de ler a informação. No exemplo, `20-data` e `30-aks` precisam da subnet e das zonas DNS da `10-network`:

- `terraform_remote_state`: lê os outputs do state da outra stack. É direto, mas quem lê precisa de acesso ao arquivo de state inteiro (que pode conter dados sensíveis) e você acopla uma stack ao formato do state da outra.
- **Data source do provider**: consulta o recurso real pela API do Azure. Exige uma convenção de nomes (a que usei nas stacks), mas dá um acoplamento mais fraco e não precisa liberar acesso a state alheio.

A HashiCorp não proíbe compartilhar outputs: nas boas práticas de workspaces ela recomenda expor só os outputs necessários a outros workspaces (via `tfe_outputs`), justamente para reduzir o risco de vazar informação sensível do state. Eu prefiro o data source por padrão e uso o `remote_state` quando preciso de um output que não existe como recurso consultável. Essa preferência é minha, baseada em experiência, não uma regra da HashiCorp, então avalie no seu contexto.

Sobre acoplamento, vale o paralelo com a capacidade [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) do DORA, que afirma que, em arquiteturas fortemente acopladas, pequenas mudanças podem causar falhas em cascata. Ela fala de arquitetura de software e de times, então a ligação com IaC é uma analogia, mas o raciocínio é o mesmo: quanto menos uma stack sabe sobre os detalhes internos da outra, menos uma mudança se espalha.

---

## Armadilhas que eu já vi acontecer

1. **Parâmetro não é cofre.** A Microsoft avisa que os valores dos parâmetros são expandidos na montagem do template e podem aparecer em logs. Segredo não vai em parâmetro. A pesquisa [*The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) (Rahman, Parnin e Williams, ICSE 2019) analisou 15.232 scripts de IaC e encontrou 21.201 ocorrências de *security smells*, 1.326 delas senhas hardcoded, e mostrou que um segredo hardcoded pode persistir por até 98 meses (mediana de 20), então não conte com "depois a gente tira". A documentação do Azure DevOps também manda validar e restringir os valores permitidos dos parâmetros, aplicar privilégio mínimo e guardar credenciais em variáveis secretas, Key Vault ou variable groups.
2. **Seleção parcial gera drift.** Se alguém marca só a stack de AKS depois de uma mudança de rede que não foi aplicada, o plano vai falhar ou, pior, ser aplicado sobre uma base desatualizada. Eu resolvo com `plan` como ação padrão e com uma rotina agendada que roda `plan` em tudo para detectar drift.
3. **Ordem de destruição.** Na criação, rede vem antes de cluster e banco. No `destroy` é o inverso. Por isso eu simplesmente não ofereço `destroy` como valor de `action` em `prd`.
4. **Quem pode clicar em "Run" é parte do controle de acesso.** O formulário de parâmetros é uma interface de controle de infraestrutura. Restrinja quem pode executar o pipeline e proteja o Environment de produção.
5. **Dividir demais.** Vinte states pequenos viram vinte pontos de dependência. Divida por ciclo de vida e por dono, não por tamanho. É o critério do Parnas, de novo.
6. **Execuções por trigger usam o default.** Se você ligar o pipeline a um `trigger`, o run automático usa os valores padrão dos parâmetros. Por isso o `trigger: none` no exemplo e o `default: false` nas stacks.
7. **Rede privada também fecha a porta do seu pipeline.** Com o ACR sem acesso público, o agente hospedado pela Microsoft deixa de alcançá-lo, como a doc do ACR avisa. Planeje o agente ou runner self-hosted dentro da VNet desde o começo. Se você também fechar o acesso público da conta do state, o mesmo vale para o `terraform init`.

---

## Prós e contras

**Prós**

- Blast radius menor e mudanças mais fáceis de revisar.
- Permissão mínima por stack e por ambiente.
- Planos mais rápidos e sem disputa de lock.
- Um único pipeline para manter, com o mesmo código em todos os ambientes.
- Módulos reaproveitados entre stacks (o `private-endpoint` do exemplo).
- Histórico claro: o run registra o que foi selecionado.

**Contras**

- Mais peças para entender: módulos, stacks, backends, templates.
- Dependências entre stacks ficam explícitas e precisam ser gerenciadas por você.
- Migrar de um state grande exige planejamento (o [guia de refatoração](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) da HashiCorp manda rodar `terraform plan` na configuração de origem e confirmar que ele não vai alterar nada).
- A seleção manual abre espaço para erro humano se você não colocar guard rails (approvals, valores permitidos, `plan` como padrão).
- Divisão errada troca um problema por outro: acoplamento entre states.
- Rede privada exige agentes dentro da rede e um desenho de DNS cuidadoso.

---

## Checklist para começar

- [ ] Mapear recursos por ciclo de vida, dono e stateful/stateless antes de dividir
- [ ] Extrair módulos para o que se repete, com nome de domínio direto em `modules/<recurso>`
- [ ] Uma stack por raiz Terraform, com `backend "azurerm" {}` vazio
- [ ] `key` = `<stack>/<ambiente>.tfstate`
- [ ] Autenticação por federação de identidade, sem segredo
- [ ] Parâmetros: `environment` com lista fechada, `action` com `plan` como padrão, um booleano por stack
- [ ] Aprovação no Environment de produção
- [ ] `plan` salvo e aplicado como artefato
- [ ] Agentes ou runners self-hosted dentro da VNet, se a rede é privada
- [ ] Rotina agendada de `plan` para detectar drift
- [ ] Documentar a ordem de dependência entre stacks

---

## FAQ

**Posso usar `object` em vez de vários booleanos no Azure DevOps?**
Pode, e dá para iterar com `${{ each }}`, o que reduz o YAML. O custo é que a entrada fica menos amigável que checkboxes e é mais fácil errar. Se quiser um meio-termo, veja a variação com `stringList` acima. Para poucas stacks, eu prefiro booleanos.

**E se eu quiser rodar todas as stacks de uma vez?**
Marque todas. Se isso for o caso mais comum, considere um parâmetro `all` ou um perfil de execução, mas mantenha a seleção individual disponível.

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

A parte que mais me convenceu foi perceber que o checkbox no pipeline é só a ponta visível. O que sustenta a ideia é o desenho por baixo: módulos que concentram o *como*, stacks que isolam o *o quê*, states que isolam o *impacto* e identidades que isolam o *quem pode*. Com isso pronto, o parâmetro vira só a forma de escolher.

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
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)

**Arquitetura de exemplo (rede privada)**
- [AKS — Clusters privados](https://learn.microsoft.com/en-us/azure/aks/private-clusters)
- [PostgreSQL Flexible Server — Rede com acesso privado](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
- [Azure Container Registry — Private Link](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)
- [Key Vault — Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)
- [Private Endpoint — Zonas DNS](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
- [Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)

**Padrões e boas práticas**
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
