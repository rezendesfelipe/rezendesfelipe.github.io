---
title: "Parâmetros no pipeline: provisione só o que você escolher (Terraform, tfstate por stack e GitOps)"
description: "Como usar parâmetros no Azure DevOps e no GitHub Actions para escolher quais stacks Terraform rodar, com um tfstate por stack e Argo CD, numa arquitetura AKS privada."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modulos", "aks", "argocd", "gitops", "postgresql", "private-link", "platform-engineering", "azure"]
readingTime: "25 min"
lang: "pt"
draft: true
---

> **TL;DR**
> - Divida a infraestrutura em *stacks* independentes, cada uma com o seu `tfstate` e construída sobre módulos. Faça o pipeline receber parâmetros que dizem **o que rodar**, **onde** e **com qual ação**.
> - O ganho: blast radius menor, privilégio mínimo por stack, `plan` mais rápido e um único pipeline para manter.
> - O exemplo é uma arquitetura real: AKS e PostgreSQL em rede privada. O Terraform entrega a rede, o cluster e o banco dedicado da aplicação. A aplicação entra no cluster pelo **Argo CD**, a partir de manifestos em `infra/argocd`.
> - O mesmo desenho funciona no Azure DevOps (`parameters`) e no GitHub Actions (`workflow_dispatch`).
> - O custo: mais peças, e dependências entre stacks que passam a ser sua responsabilidade.

---

## O problema que me fez chegar nisso

Todo time de infraestrutura passa por uma fase parecida. Começa com um repositório Terraform, um `main.tf` e um pipeline que roda `terraform apply`. Funciona até o dia em que o arquivo cresce: rede, banco, cluster, Key Vault, monitoramento, tudo no mesmo state.

Aí aparecem os sintomas, e eu já vivi todos:

- Você só queria criar uma subnet, mas o `plan` leva 12 minutos porque aplica refresh em 600 recursos.
- Um diff inesperado no cluster aparece no plano de uma mudança que era só de rede.
- Duas pessoas mexem em partes diferentes e uma fica esperando o lock da outra.
- O service principal do pipeline tem permissão para tudo, porque o state é um só.
- Um erro humano num `apply` atinge o banco de dados junto com o resto.

O que eu uso hoje tem duas metades que andam juntas:

1. **Desenho:** a infraestrutura é dividida em *stacks* independentes, cada uma com o seu `tfstate`, construídas em cima de **módulos** reutilizáveis.
2. **Execução:** o pipeline recebe **parâmetros** que dizem *quais* stacks rodar, em *qual* ambiente e com *qual* ação.

Uma metade sem a outra não resolve. Parâmetro sem state separado vira um checkbox que não muda nada. State separado sem parâmetro vira um monte de pipelines duplicados.

> **Como ler este artigo.** Todo link aponta para documentação oficial ou pesquisa publicada. Quando uma ideia é minha, e não da fonte, eu marco como **leitura minha**. O código é simplificado para explicar o desenho: adapte nomes, versões e permissões ao seu ambiente e teste em dev antes de qualquer coisa. Se você quer ver os parâmetros funcionando, pule para [Parâmetros no pipeline](#parâmetros-no-pipeline). O código completo das stacks e dos módulos está no [Anexo](#anexo-código-das-stacks-e-dos-módulos).

---

## A ideia em uma imagem

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="Painel de parâmetros (ambiente, instância, ação e um checkbox por etapa) alimenta um pipeline único, que executa apenas as etapas marcadas: as stacks vnet-core-prod-brs-01 e aks-core-prod-brs-01. A stack da aplicação orders e o bootstrap do Argo CD estão desmarcados e não rodam. Cada stack grava em um tfstate próprio, nomeado como o recurso, no mesmo container do Azure Storage." loading="lazy" />
    <figcaption>Figura 1 — Os parâmetros escolhem o que roda. Cada stack tem o seu tfstate, então o que não foi selecionado nem é lido nem é alterado.</figcaption>
</figure>

O pipeline é um só, e o que muda de um run para outro são os parâmetros. Como cada stack tem o seu state, "não rodar" uma stack é seguro: ela simplesmente não participa.

---

## Por que isso importa

### 1. Blast radius menor

A HashiCorp diz, nas [boas práticas de workspaces](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices), que qualquer operação num recurso pode afetar os outros recursos do mesmo state, e que o ideal é manter o raio de impacto pequeno: agrupar por volatilidade (o que muda sempre fica longe do que quase nunca muda), separar stateful de stateless (banco longe de computação) e dividir por responsabilidade e privilégios. A mesma página avisa que planos e applies lentos são sinal precoce de escopo inchado, e o guia de [refatoração de state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) reforça que recursos com cadências diferentes devem ser gerenciados separadamente.

Na prática: errar um `apply` na stack do cluster não coloca a rede nem o banco na linha de tiro.

### 2. Menos privilégio

Cada stack pode rodar com uma identidade diferente, com a permissão mínima de que precisa: a rede pede `Network Contributor` no escopo dela, a stack da aplicação pede outro conjunto, e o pipeline com `Owner` na subscription deixa de ser necessário. A HashiCorp recomenda dividir workspaces por responsabilidade e privilégios justamente por isso. A mesma lógica aparece nas [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy), que separam a plataforma dos workloads (a ligação com stacks de Terraform é **leitura minha**).

### 3. Feedback mais rápido

`plan` menor, `apply` menor, lock menor. O backend `azurerm` usa recursos nativos do Blob Storage para o lock ([doc do backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) e [doc da Microsoft](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)). Como cada stack é um blob com a sua `key`, ninguém espera ninguém.

### 4. Mudanças pequenas e frequentes

O Azure Well-Architected Framework, no item [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recomenda releases pequenos e incrementais, com quality gates, e deploys padronizados e automatizados para reduzir erro humano. Selecionar só o que mudou é a versão de infraestrutura dessa ideia.

O DORA mede [cinco métricas de entrega](https://dora.dev/guides/dora-metrics/) e afirma que velocidade e estabilidade não são trade-offs. Que mudanças menores e mais isoladas ajudam nelas é **leitura minha**, apoiada no relatório de [2024](https://dora.dev/research/2024/dora-report/): lotes pequenos e testes robustos continuam cruciais.

### 5. Um pipeline para manter, não dez

Em vez de `pipeline-vnet.yml`, `pipeline-aks.yml` e `pipeline-app.yml` com 90% de código igual, existe um template de stack e um orquestrador: corrigiu a autenticação uma vez, corrigiu para todas. A capacidade [Deployment automation](https://dora.dev/capabilities/deployment-automation/) do DORA descreve esse formato, e o [Twelve-Factor App](https://12factor.net/config) dá o critério: config é o que muda entre deploys e fica fora do código, e a "fiação" interna fica no código. Aqui, ambiente e instância são config. A chamada de módulos dentro de cada stack é código.

---

## A arquitetura de referência

Para o exemplo não ficar abstrato, escolhi uma arquitetura que eu encontro com frequência: uma aplicação em **AKS** com um **PostgreSQL** dedicado a ela, tudo em rede privada. Os ícones são os oficiais da Microsoft ([Azure Architecture Icons](https://learn.microsoft.com/en-us/azure/architecture/icons/), usados conforme os termos: sem alterar o formato e com o nome do produto junto ao ícone).

<figure>
    <img src="/images/blog/2026-11-21/arquitetura-aks-postgresql-privada.svg" alt="Arquitetura de referência em rede privada: usuários da rede corporativa entram por um ingress interno no cluster aks-core-prod-brs-01, dentro da subnet snet-aks, onde roda o pod orders. O pod acessa o PostgreSQL dedicado pgsql-orders-prod-brs-01, na subnet delegada snet-postgres, e, por Private Endpoints na snet-endpoints, o Key Vault. O cluster puxa imagens do Container Registry por outro Private Endpoint. O Argo CD, dentro do cluster, sincroniza os manifestos de um repositório Git com o pod. Agentes self-hosted na snet-agents executam o Terraform e o bootstrap do Argo CD. Zonas Private DNS vinculadas à VNet resolvem os nomes. Cada recurso está marcado com a stack Terraform dona dele: vnet-core-prod-brs-01, aks-core-prod-brs-01 ou app-orders-prod-brs-01." loading="lazy" />
    <figcaption>Figura 2 — Arquitetura de referência. As pílulas mostram a stack Terraform dona de cada recurso. O pod entra no cluster pelo Argo CD, a partir do Git, fora do Terraform. A fonte editável está em draw.io.</figcaption>
</figure>

O que a figura mostra, e a documentação por trás de cada decisão:

- **AKS como cluster privado.** Com `private_cluster_enabled`, o servidor de API recebe um IP interno e conversa com os nós por Azure Private Link ([docs](https://learn.microsoft.com/en-us/azure/aks/private-clusters)).
- **PostgreSQL com integração de rede (private access).** O servidor fica numa subnet **delegada**, de uso exclusivo dele, com no mínimo `/28`, e precisa de uma zona Private DNS terminada em `postgres.database.azure.com`. Via Terraform, você cria essas zonas, e o nome da zona não pode ser igual ao do servidor ([docs](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)).
- **ACR e Key Vault por Private Endpoint.** O private link do ACR exige o SKU **Premium** ([docs](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). O Key Vault usa o mesmo mecanismo ([docs](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)). Zonas DNS e subrecursos (`registry`, `vault`) estão na [tabela de zonas](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- **Agentes self-hosted na VNet.** O pipeline precisa alcançar a API do cluster (no bootstrap do Argo CD) e, se você fechar o acesso público, o registry e a conta do state. A doc do ACR avisa que, sem acesso público, o Azure DevOps Services deixa de acessá-lo, e a doc de [acesso a clusters privados](https://learn.microsoft.com/en-us/azure/aks/access-private-cluster) diz que o `az aks command invoke` não serve para acesso programático. Os agentes ficam fora das stacks deste exemplo (a `snet-agents` aparece tracejada).
- **Argo CD dentro do cluster, puxando do Git.** O [Argo CD](https://argo-cd.readthedocs.io/en/stable/) é um controller do Kubernetes que compara continuamente o estado vivo com o estado desejado, definido no Git. Como ele busca as mudanças no Git, o pipeline só precisa alcançar a API privada no bootstrap (**leitura minha** do modelo que a doc descreve). O preço está na figura: o cluster precisa alcançar o repositório Git.
- **Fora do escopo, de propósito:** o desenho de saída (egress) do cluster, que é uma decisão à parte com firewall ou NAT (o provider aceita `loadBalancer`, `userDefinedRouting`, `managedNATGateway`, `userAssignedNATGateway` e `none` em `outbound_type`).

### Padrão de nomes

Eu nomeio tudo como `<tipo>-<nome>-<ambiente>-<região>-<seq>`. O **nome** diz o que o recurso é ou a quem ele serve: `core` para a plataforma compartilhada, `orders` para a aplicação. Alguns exemplos:

| Recurso | Nome |
|---|---|
| VNet da plataforma | `vnet-core-prod-brs-01` |
| Cluster AKS | `aks-core-prod-brs-01` |
| Banco da aplicação orders | `pgsql-orders-prod-brs-01` |
| Key Vault da aplicação orders | `kv-orders-prod-brs-01` |
| Qualquer outro recurso, até uma VM | `vm-orders-prod-brs-01` |

O tipo segue as [abreviações do Cloud Adoption Framework](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations) (`vnet`, `snet`, `aks`, `kv`, `rg`, `pep` para private endpoint, `pgsql` para PostgreSQL flexible server, `cr` para container registry, `id` para managed identity), e a ordem dos componentes é a que a Microsoft documenta em [definir a convenção de nomes](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming). O `brs` é o código curto de Brazil South do meu padrão, não da Microsoft. O resource group leva o nome do recurso principal que guarda, com o prefixo `rg-`: `rg-vnet-core-prod-brs-01`.

Duas regras dessa documentação pesam aqui. A maioria dos nomes não muda depois de criada, então só entra no nome o que é permanente (o resto vai em tag). E alguns nomes são globais e têm regras próprias: segundo a [tabela de regras de nomes](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules), o Key Vault aceita 3 a 24 caracteres, com letras, números e hífens, e o ACR aceita 5 a 50 caracteres e **só letras e números**. Por isso o registry se chama `crcoreprodbrs01`.

O nome do recurso vira o nome do state: o `tfstate` da rede é `vnet-core-prod-brs-01.tfstate`, e quem abre o container do state vê exatamente o que cada blob guarda.

### Quem é dono de quê

A pergunta que define a divisão é "quem muda isso, e com que frequência". Para esta arquitetura:

| Stack (pasta) | Recursos | Módulos | `key` do state |
|---|---|---|---|
| `vnet-core` | VNet, subnets, NSGs, zonas Private DNS | `network` | `vnet-core-prod-brs-01.tfstate` |
| `aks-core` | AKS, ACR e o Private Endpoint dele | `aks`, `acr`, `private-endpoint` | `aks-core-prod-brs-01.tfstate` |
| `app-orders` | PostgreSQL dedicado, Key Vault e o Private Endpoint dele, identidade da aplicação | `postgresql`, `key-vault`, `private-endpoint`, `workload-identity` | `app-orders-prod-brs-01.tfstate` |
| *(fora do Terraform)* | Argo CD (bootstrap) e o pod `orders` | Script de bootstrap e manifestos em `infra/argocd` | não tem state |

Dois detalhes. O módulo `private-endpoint` é usado por duas stacks, e esse é o tipo de reaproveitamento que justifica um módulo: o guia de refatoração da HashiCorp recomenda agrupar em módulo o conjunto de recursos que você cria em várias configurações. E a stack `aks-core` também guarda o ACR: ela leva o nome do recurso principal, e o registry é apoio.

### Duas decisões de desenho

**O PostgreSQL é dedicado à aplicação e entra como uma chamada de módulo na stack dela.** Eu não crio um servidor compartilhado numa stack de "dados". A `orders` pede o banco dela do mesmo jeito que pede o Key Vault e a identidade, e o ciclo de vida do banco acompanha o da aplicação. Tamanho, SKU e storage são parâmetros da chamada. É uma escolha minha, com prós e contras:

- **Prós:** blast radius por aplicação, privilégio por aplicação, dimensionamento por aplicação e remoção completa quando ela sai.
- **Contras:** mais servidores para custear e operar (backup, patch, monitoramento). Se muitas aplicações pequenas têm o mesmo perfil de uso, um servidor compartilhado pode fazer mais sentido. Avalie com os números do seu ambiente.

**O pod entra no cluster pelo Argo CD, não pelo Terraform.** O critério é o da HashiCorp: agrupar por volatilidade e separar stateful de stateless. A aplicação muda várias vezes por dia e é stateless. O banco muda raramente e guarda dados. Se o pod fosse um recurso Terraform, cada nova versão da imagem passaria por `plan` e `apply` no mesmo state do banco. Com GitOps, a etapa mais frequente vira um commit nos manifestos, longe do state que menos pode errar. Essa aplicação da regra ao caso do Argo CD é **leitura minha**, porque a página da HashiCorp não fala de GitOps.

---

## Como o repositório e o state se organizam

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
│   ├── vnet-core/
│   ├── aks-core/
│   └── app-orders/
├── envs/
│   ├── dev-brs-01.tfvars
│   ├── hml-brs-01.tfvars
│   └── prod-brs-01.tfvars
├── argocd/                   # GitOps: Argo CD e os manifestos das aplicações
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

A regra que eu sigo:

- **Módulo** é o *como*: uma receita reutilizável. Fica direto em `modules/<recurso>`, com o nome do domínio (`network`, `aks`, `postgresql`), sem subpastas por equipe ou projeto. Não tem backend nem state.
- **Stack** é o *o quê e onde*: uma raiz Terraform que chama módulos, tem backend próprio e é o que o pipeline executa. O nome da pasta já carrega tipo e nome (`vnet-core`, `app-orders`).
- **Instância** (ambiente, região e sequência) é só dado: um `.tfvars` e uma `key` diferente no backend. `prod-brs-01` e `dev-brs-01` rodam o mesmo código.

Essa separação tem um pai acadêmico. No clássico [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) (Parnas, CACM, 1972), o resumo diz que a eficácia de uma modularização depende do critério usado para dividir o sistema. É um artigo sobre software, não sobre IaC, então a ligação é **leitura minha**, mas a pergunta vale antes de criar pastas: dividir por quê? Eu divido por ciclo de vida e por dono, não por tamanho nem por tipo de recurso.

### O backend: um state por stack e por instância

Cada stack declara o backend vazio e recebe o resto no `init` (o que o Terraform chama de *partial configuration*):

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

O `init` define a `key`, que no `azurerm` é o nome do blob dentro do container:

```bash
terraform init -input=false \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=sttfstatecorp001" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=aks-core-prod-brs-01.tfstate"
```

No fim, o container fica assim:

```text
tfstate/
├── vnet-core-dev-brs-01.tfstate
├── vnet-core-prod-brs-01.tfstate
├── aks-core-dev-brs-01.tfstate
├── aks-core-prod-brs-01.tfstate
├── app-orders-dev-brs-01.tfstate
└── app-orders-prod-brs-01.tfstate
```

Duas coisas para cuidar: a conta do state deve ficar fora do que o Terraform gerencia nas stacks, e a autenticação deve ser por Microsoft Entra ID, não por access key. A [documentação](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) marca o access key como "não recomendado para novas cargas" e indica `Storage Blob Data Contributor` no container como a opção de menor privilégio.

### Como uma stack enxerga a outra

`aks-core` e `app-orders` precisam da subnet e das zonas DNS da `vnet-core`, e `app-orders` precisa do emissor OIDC do cluster. Há duas formas de ler isso:

- **`terraform_remote_state`:** lê os outputs do state da outra stack. É direto, mas quem lê precisa de acesso ao state inteiro (que pode ter dados sensíveis) e fica acoplado ao formato dele.
- **Data source do provider:** consulta o recurso real pela API do Azure. Exige uma convenção de nomes (o padrão acima faz esse papel), mas o acoplamento é mais fraco e ninguém precisa de acesso a state alheio. Para o emissor OIDC, o data source `azurerm_kubernetes_cluster` expõe `oidc_issuer_url`.

A HashiCorp não proíbe compartilhar outputs: ela recomenda expor só os necessários (via `tfe_outputs`) justamente para reduzir o risco de vazar dado sensível do state. Eu uso data source por padrão e `remote_state` quando o output não existe como recurso consultável. Essa preferência é **minha**, não uma regra da HashiCorp.

Sobre acoplamento, a capacidade [Loosely coupled teams](https://dora.dev/capabilities/loosely-coupled-architecture/) do DORA afirma que, em arquiteturas fortemente acopladas, pequenas mudanças podem causar falhas em cascata. Ela fala de software e de times (analogia, de novo), mas o raciocínio vale: quanto menos uma stack sabe da outra, menos uma mudança se espalha.

O código completo de cada stack e dos módulos está no [Anexo](#anexo-código-das-stacks-e-dos-módulos). Um detalhe do exemplo de PostgreSQL do provider: ele usa `depends_on` no link entre a zona DNS e a VNet. Na divisão em stacks, esse `depends_on` vira **ordem de execução**: a `vnet-core` roda antes. É o que o `dependsOn` do pipeline garante, logo abaixo.

---

## Parâmetros no pipeline

Agora o centro do artigo. O pipeline recebe um parâmetro por etapa, e só as etapas marcadas rodam. As etapas são as três stacks Terraform e o bootstrap do Argo CD (uma vez por cluster). Depois do bootstrap, a aplicação evolui por Git.

### Azure DevOps

O Azure Pipelines tem [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): você declara tipo, valor padrão e, se quiser, uma lista de valores permitidos, e a tela de **Run pipeline** monta o formulário. Para o que a gente quer, três tipos resolvem: `string` com `values` (lista de opções), `boolean` (checkbox) e `object` (estruturas mais ricas).

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # execução sempre intencional; ver "Armadilhas"

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

  - name: vnetCore
    displayName: "vnet-core · rede privada"
    type: boolean
    default: false

  - name: aksCore
    displayName: "aks-core · cluster e ACR"
    type: boolean
    default: false

  - name: appOrders
    displayName: "app-orders · PostgreSQL dedicado, Key Vault e identidade"
    type: boolean
    default: false

  - name: argocd
    displayName: "argocd · instalação e Application raiz (uma vez por cluster)"
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

O ponto central são as expressões `${{ if ... }}`. Elas são **expressões de template**, resolvidas quando o pipeline é montado ([doc de template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)). Isso significa que o stage de uma etapa desmarcada **não existe** no run: não aparece como "skipped" e não consome agente.

Os `dependsOn` condicionais resolvem um detalhe chato: declarar dependência de um stage que não foi incluído faz a validação falhar. Aqui, cada dependência só existe quando a etapa correspondente foi marcada, e a lista fica vazia quando nenhuma foi. Eu usei a inserção condicional em sequências que a doc descreve, mas não executei esse formato exato.

O template de cada stack faz `init`, `plan` e, se a ação for `apply`, o `apply` com aprovação:

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

O template do bootstrap do Argo CD usa o mesmo Environment, e portanto as mesmas aprovações, com uma service connection própria:

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

O que importa nesse desenho:

- **Uma service connection para o Terraform** (`sc-terraform-prod`) **e outra para o bootstrap** (`sc-aks-bootstrap-prod`), com federação de identidade: quem aplica infraestrutura não precisa mexer em workloads, e vice-versa.
- **O pool `agentes-privados` fica dentro da VNet**, porque o ACR (e, se você fechar, o state) não aceita acesso público e a API do cluster é privada.
- **A aprovação vive no Environment**, não no YAML. Segundo a [documentação](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals), aprovações e checks não são definidos no YAML, e quem edita o YAML não consegue alterá-los.
- **O `plan` é publicado como artefato e o `apply` aplica aquele plano**: o que foi revisado é o que vai ser aplicado.

O script que os dois passos de Terraform usam:

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

> **Nota sobre a autenticação no Azure DevOps.** A task [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) expõe `$servicePrincipalId` e `$tenantId` quando `addSpnToEnvironment: true` e a service connection usa federação. Para o **backend**, a [doc do `azurerm`](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) diz que os endpoints do token OIDC são achados automaticamente no Azure DevOps. Para o **provider**, o [guia de OIDC](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) usa `SYSTEM_ACCESSTOKEN` e `SYSTEM_OIDCREQUESTURI` (por isso o `env:` das tasks) e exige o ID da service connection em `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. Reaproveitar o `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` nessa variável é **leitura minha**: o guia usa uma variável própria.

### GitHub Actions

No GitHub, o equivalente é o `workflow_dispatch` com `inputs`. Os tipos são `string`, `choice`, `boolean`, `environment` e `number` ([changelog de input types](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)). O tipo `environment` lista os Environments do repositório como opções. Desde dezembro de 2025, o limite é de [25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/) (antes eram 10).

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
      vnet_core:
        description: "vnet-core · rede privada"
        type: boolean
        default: false
      aks_core:
        description: "aks-core · cluster e ACR"
        type: boolean
        default: false
      app_orders:
        description: "app-orders · PostgreSQL dedicado, Key Vault e identidade"
        type: boolean
        default: false
      argocd:
        description: "argocd · instalação e Application raiz (uma vez por cluster)"
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

Aqui há uma diferença importante em relação ao Azure DevOps: a condição é avaliada **em tempo de execução**, então o job desmarcado aparece como *skipped*. Segundo a [documentação](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), um job que depende de outro falho ou pulado também é pulado, a menos que use uma expressão condicional que o faça continuar. O `!cancelled() && !failure()` faz isso: "rode se nada falhou, mesmo que a dependência tenha sido pulada". Outro detalhe: o contexto `inputs` preserva booleanos, enquanto `github.event.inputs` converte tudo em string. Por isso o `if` usa `inputs.vnet_core` direto.

O workflow reutilizável do Terraform:

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

E o do bootstrap do Argo CD:

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
        run: ./infra/scripts/bootstrap-argocd.sh "${{ inputs.environment }}" "${{ inputs.instance }}"
```

O runner precisa ter `az` e `kubectl` instalados. O login usa a action `azure/login`, que é o fluxo da [documentação do GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure), e o `bootstrap-argocd.sh` é o mesmo script do Azure DevOps.

O que importa no GitHub:

- **Workflows reutilizáveis** são chamados no nível do job e recebem `inputs` com `with` ([doc](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)). O job que chama o reutilizável não pode usar `environment`: quem declara é o job dentro dele, como fizemos.
- **Autenticação por OIDC, sem segredo.** O provider detecta sozinho as variáveis do GitHub Actions, desde que o workflow tenha `id-token: write` ([guia de OIDC do provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)).
- **Uma credencial federada por ambiente.** Com um Environment no job, o *subject* do token é `repo:ORG/REPO:environment:NOME`, então o `prod` só aceita tokens de jobs do Environment `prod`. Atenção: repositórios criados depois de 15/07/2026 usam, por padrão, um subject imutável com os IDs do dono e do repositório ([referência de OIDC](https://docs.github.com/en/actions/reference/security/oidc)), e a [Microsoft recomenda migrar](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) as credenciais baseadas em nome. Confirme como fica o subject de ambiente no seu repositório, porque a doc só mostra o exemplo imutável com branch.
- **Plan e apply no mesmo job.** Se o Environment tiver *required reviewers*, a aprovação é pedida **antes** do plan. Se isso incomoda, use dois Environments (`dev-plan` e `dev-apply`) ou separe em dois jobs.

### Azure DevOps ou GitHub Actions?

| Ponto | Azure DevOps | GitHub Actions |
|---|---|---|
| Parâmetro do run | `parameters` com `type` e `values` | `workflow_dispatch.inputs` |
| Quando a seleção é aplicada | Na montagem: o stage nem existe | Na execução: o job aparece como skipped |
| Aprovação | Environment com approvals e checks | Environment com required reviewers |
| Reuso | Templates (`template:`) | Workflows reutilizáveis (`workflow_call`) |
| Autenticação | Service connection com federação | OIDC com credencial federada por Environment |
| Limite que me pegou | Parâmetros precisam de `default`; run por trigger usa os defaults | 25 inputs; até 10 níveis de workflows encadeados |

Nenhum é melhor em tudo. A diferença entre "stage inexistente" e "job skipped" parece detalhe, mas muda como você lê o histórico de execuções e como configura as dependências.

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

### Como a aplicação muda depois disso

Uma nova versão da `orders` vira uma mudança no `newTag` do overlay, num pull request. O review desse PR é a aprovação do deploy, e a branch policy do repositório é o controle. No prod, o passo seguinte é a sincronização manual. Em nenhum momento o pipeline de infraestrutura entra em cena, nem precisa alcançar a API do cluster.

---

## Armadilhas que eu já vi acontecer

1. **Parâmetro não é cofre.** A Microsoft avisa que os valores dos parâmetros são expandidos na montagem do template e podem aparecer em logs. A pesquisa [*The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) (Rahman, Parnin e Williams, ICSE 2019) analisou 15.232 scripts de IaC, achou 21.201 *security smells* (1.326 deles senhas hardcoded) e mostrou que um segredo hardcoded pode persistir por até 98 meses. Guarde credenciais em variáveis secretas ou no Key Vault, e restrinja os valores permitidos dos parâmetros.
2. **Seleção parcial gera drift.** Se alguém marca só o cluster depois de uma mudança de rede que não foi aplicada, o plano falha ou, pior, roda sobre uma base desatualizada. Eu uso `plan` como ação padrão e uma rotina agendada que roda `plan` em tudo para detectar drift.
3. **Ordem de execução e de destruição.** Na criação: `vnet-core`, `aks-core`, `app-orders` e o bootstrap do Argo CD. No `destroy` é o inverso, e o banco guarda dados. Por isso eu não ofereço `destroy` como valor de `action` em `prod`.
4. **A ponte entre Terraform e Git.** Se a Application da `orders` entra no Git antes de o banco e a identidade existirem, o pod sobe sem conseguir conectar: aplique a stack `app-orders` antes de mergear o PR que cria a Application. E se alguém recria o banco ou a identidade e esquece de atualizar o overlay, o Argo CD continua sincronizando os valores antigos, porque para ele o Git está certo.
5. **Quem pode clicar em "Run" é parte do controle de acesso.** O formulário de parâmetros é uma interface de controle da infraestrutura: restrinja quem executa o pipeline e proteja o Environment de produção. E, se ligar um `trigger`, lembre que o run automático usa os valores padrão (por isso o `trigger: none` e o `default: false`).
6. **Dividir demais.** Vinte states pequenos viram vinte pontos de dependência. Divida por ciclo de vida e por dono, não por tamanho (o critério do Parnas, de novo).
7. **Rede privada também fecha a porta do seu pipeline.** Planeje o agente ou runner self-hosted dentro da VNet desde o começo. Com o Argo CD, o pipeline só precisa da API no bootstrap, mas o cluster passa a precisar sair para o Git.
8. **O Argo CD também tem armadilhas.** A doc avisa que o app of apps é uma capacidade de administrador: só admins devem ter push no repositório da Application pai, e os pull requests precisam de review, com atenção ao campo `project`. Proteja `infra/argocd/apps` com branch policy. E lembre que o sync automático só apaga o que saiu do Git se você habilitar o prune, e que, com o finalizer, apagar uma Application apaga o que ela gerencia. Decida isso de propósito, principalmente no prod.

---

## Prós, contras e quando eu não usaria

**Prós**

- Blast radius menor e mudanças mais fáceis de revisar.
- Permissão mínima por stack, por ambiente e por aplicação.
- Planos mais rápidos e sem disputa de lock.
- Um pipeline para manter, com o mesmo código em todas as instâncias.
- Módulos reaproveitados entre stacks (o `private-endpoint`).
- Banco dedicado por aplicação, com o ciclo de vida da aplicação.
- Deploys frequentes por Git, longe do state que menos pode errar, e auditáveis: o histórico de commits e o review do PR são o registro e a aprovação.
- Nomes que dizem o que cada recurso e cada state guardam.

**Contras**

- Mais peças para entender: módulos, stacks, backends, templates, manifestos.
- Dependências entre stacks ficam explícitas e são sua responsabilidade, incluindo a ponte Terraform → manifestos.
- Migrar de um state grande exige planejamento. O [guia de refatoração](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) manda rodar `terraform plan` na configuração de origem e confirmar que nada vai mudar.
- A seleção manual abre espaço para erro humano sem guard rails (approvals, valores permitidos, `plan` como padrão).
- Um banco por aplicação aumenta custo e operação.
- Mais um componente para operar (o Argo CD) e um cluster que precisa alcançar o Git.
- Rede privada exige agentes dentro da rede e um desenho de DNS cuidadoso.

**Quando eu não usaria.** Com um ambiente só, poucos recursos e um time de uma ou duas pessoas, um state único e um pipeline simples custam menos do que tudo isso. O desenho compensa quando o state começa a doer: planos lentos, locks disputados, medo de mexer no que não deveria. Comece pelo que muda mais, ou pelo que seria mais caro quebrar (normalmente rede e dados), e ande daí.

---

## Checklist para começar

- [ ] Mapear recursos por ciclo de vida, dono e stateful/stateless antes de dividir
- [ ] Definir o padrão de nomes (`tipo-nome-ambiente-região-seq`) antes do primeiro `apply`, porque a maioria dos nomes não muda depois
- [ ] Extrair módulos para o que se repete, com nome de domínio direto em `modules/<recurso>`
- [ ] Uma stack por raiz Terraform, com `backend "azurerm" {}` vazio
- [ ] `key` do state = `<stack>-<ambiente>-<região>-<seq>.tfstate`
- [ ] Autenticação por federação de identidade, sem segredo
- [ ] Parâmetros: `environment` e `instance` com lista fechada, `action` com `plan` como padrão, um booleano por etapa
- [ ] Aprovação no Environment de produção, para o Terraform e para o bootstrap do Argo CD
- [ ] `plan` salvo e aplicado como artefato
- [ ] Banco dedicado como chamada de módulo na stack da aplicação, se esse for o seu modelo
- [ ] Deploy por Argo CD, com manifestos em `infra/argocd` e uma Application por instância
- [ ] Aprovação do deploy de produção no pull request (branch policy) e, se preferir, sincronização manual
- [ ] Agentes ou runners self-hosted dentro da VNet, se a rede é privada
- [ ] Rotina agendada de `plan` para detectar drift
- [ ] Documentar a ordem de dependência entre as etapas

---

## FAQ

**Por que não um state só, com `-target`?**
Eu já vi quem tentasse: um state, e um parâmetro passando `-target=module.aks`. A [documentação do Terraform](https://developer.hashicorp.com/terraform/cli/commands/plan) diz para usar `-target` só em circunstâncias excepcionais (como se recuperar de erros) e que não é recomendado para operações de rotina. Ele não resolve o lock, o tempo de refresh, o blast radius nem a separação de permissões. É o checkbox sem a metade do desenho.

**Posso usar `object` ou `stringList` em vez de vários booleanos no Azure DevOps?**
Pode. O `object` permite iterar com `${{ each }}`, e o `stringList` deixa marcar vários itens numa lista, mas a doc avisa que ele não está disponível em templates. O custo é uma entrada menos amigável que checkboxes e dependências mais trabalhosas de montar. Eu não testei essas variações. Para poucas etapas, prefiro booleanos, e para rodar tudo de uma vez basta marcar todos.

**Por que Argo CD, e não deploy pelo pipeline ou pelo provider Helm do Terraform?**
Porque a aplicação muda muito mais do que o banco e a rede, e a regra de volatilidade da HashiCorp aponta para manter essa etapa fora do state da infraestrutura. O Argo CD também mantém o cluster reconciliado com o Git, e o pipeline não precisa alcançar a API privada a cada deploy. É uma escolha de desenho minha: se o seu time não quer operar o Argo CD, Helm no pipeline também funciona. E o Argo CD aceita charts Helm, Kustomize e diretórios de YAML ([doc](https://argo-cd.readthedocs.io/en/stable/)), então você pode manter charts no lugar do overlay.

**Por que o PostgreSQL usa subnet delegada e não Private Endpoint?**
Porque escolhi a integração de rede (private access). A [documentação](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private) apresenta duas opções para o PostgreSQL Flexible Server: private access (o que usei) ou acesso público com Private Endpoint. Veja o que muda em cada uma antes de criar o servidor.

**Isso funciona com Bicep ou OpenTofu?**
O desenho de parâmetros, stacks independentes e pipeline único serve para qualquer IaC. O específico do Terraform aqui é o `tfstate` e o backend. O OpenTofu usa o mesmo modelo de backend `azurerm`, mas confirme as particularidades na documentação dele.

**Como migro de um state único?**
Planeje o agrupamento, mova os recursos com blocos `removed` e `import` (o guia de refatoração da HashiCorp detalha), e confirme que o `terraform plan` não mostra mudanças em nenhuma das stacks. Comece em dev.

---

## Fechando

O checkbox no pipeline é só a ponta visível. O que sustenta a ideia é o desenho por baixo: módulos que concentram o *como*, stacks que isolam o *o quê*, states que isolam o *impacto*, nomes que dizem o que cada coisa é e identidades que isolam o *quem pode*. Com isso pronto, o parâmetro vira só a forma de escolher.

Se você só tem um state hoje, não precisa dividir tudo de uma vez. Escolha a parte que mais dói e comece por ela. Se você já fez essa divisão de outro jeito, eu gostaria de saber o que funcionou e o que não funcionou no seu caso.

---

## Anexo: código das stacks e dos módulos

Os trechos abaixo mostram as três stacks e os módulos citados no texto. Todas as stacks recebem `environment` e `instance` e derivam os nomes do mesmo sufixo (`prod-brs-01`).

**`vnet-core`** chama o módulo `network` e é a dona da VNet, das subnets e das zonas DNS:

```hcl
# infra/stacks/vnet-core/main.tf (terraform {} e provider como no exemplo do backend)
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

**`aks-core`** não cria rede. Consulta a subnet e a zona do ACR que a `vnet-core` criou, e cria o registry, o endpoint privado e o cluster:

```hcl
# infra/stacks/aks-core/main.tf (continuação do bloco terraform/provider da seção do backend)
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
  source = "../../modules/acr" # sku = "Premium", acesso público desabilitado

  name = "cr${local.name}${var.environment}${replace(var.instance, "-", "")}"   # crcoreprodbrs01 (só letras e números)
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
```

**`app-orders`** é a stack da aplicação. O banco é uma chamada de módulo dedicada. Ela consulta a rede e as zonas DNS da `vnet-core` e o emissor OIDC do cluster da `aks-core`:

```hcl
# infra/stacks/app-orders/main.tf (terraform {} e provider como no exemplo do backend)
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

  name                 = "id-orders-${local.suffix}"     # id-orders-prod-brs-01
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

O Key Vault do exemplo usa RBAC (`rbac_authorization_enabled = true`) e `public_network_access_enabled = false`, atributos documentados do recurso [`azurerm_key_vault`](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault).

Se os módulos vivem em outro repositório, o `source` aponta para uma tag, para a versão ficar travada: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## Referências

**Azure DevOps e GitHub Actions**
- [Azure Pipelines — Runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters)
- [Azure Pipelines — Template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions)
- [Azure Pipelines — Approvals e checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
- [Azure Pipelines — Task AzureCLI@2](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2)
- [GitHub — Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch agora aceita 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Referência de OIDC](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub — OIDC no Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — Subjects imutáveis do GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)

**Terraform**
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — terraform plan e `-target`](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [HashiCorp — Backend azurerm](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)
- [azurerm — Guia de OIDC](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc)
- [azurerm — postgresql_flexible_server](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [azurerm — kubernetes_cluster (data source)](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/kubernetes_cluster)
- [azurerm — key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)

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
