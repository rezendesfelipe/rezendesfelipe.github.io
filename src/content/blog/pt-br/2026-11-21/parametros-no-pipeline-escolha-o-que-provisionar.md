---
title: "Parâmetros no pipeline: provisione só o que você escolher (Terraform e um tfstate por stack)"
description: "Como usar parâmetros no Azure DevOps e no GitHub Actions para escolher quais stacks Terraform rodar, com um tfstate por stack e nomes que dizem o que cada coisa guarda."
pubDate: 2026-11-21
updatedDate: 2026-11-22
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modulos", "platform-engineering", "azure"]
readingTime: "19 min"
lang: "pt"
draft: false
---

> **TL;DR**
> - Divida a infraestrutura em *stacks* independentes, cada uma com o seu `tfstate` e construída sobre módulos. Faça o pipeline receber parâmetros que dizem **o que rodar**, **onde** e **com qual ação**.
> - O ganho: blast radius menor, privilégio mínimo por stack, `plan` mais rápido e um único pipeline para manter.
> - O mesmo desenho funciona no Azure DevOps (`parameters`) e no GitHub Actions (`workflow_dispatch`).
> - Os nomes seguem `tipo-nome-ambiente-região-seq`, e o nome do state é o nome do recurso.
> - O custo: mais peças, e dependências entre stacks que passam a ser sua responsabilidade.
> - Esta é a **Parte 1 de 2**. A [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/) mostra a arquitetura de referência (AKS e PostgreSQL em rede privada) e o deploy da aplicação por Argo CD.

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

> **Como ler este artigo.** Todo link aponta para documentação oficial ou pesquisa publicada. Quando uma ideia é minha, e não da fonte, eu marco como **leitura minha**. O código é simplificado para explicar o desenho: adapte nomes, versões e permissões ao seu ambiente e teste em dev antes de qualquer coisa. Se você quer ver os parâmetros funcionando, pule para [Parâmetros no pipeline](#parâmetros-no-pipeline). O código das stacks e dos módulos está na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/). **Atualização (22/11/2026):** revalidei o código com `terraform validate`, `actionlint`, `shellcheck` e `kustomize build` e corrigi o que não passava: versões mínimas do Terraform (1.12) e do provider (4.65), as variáveis do state, o tratamento de erro do `tf.sh` e a nota sobre a service connection.

---

## A ideia em uma imagem

<figure>
    <img src="/images/blog/2026-11-21/parametros-selecionam-stacks.svg" alt="Painel de parâmetros (ambiente, instância, ação e um checkbox por stack) alimenta um pipeline único, que executa apenas as stacks marcadas: vnet-core-prod-brs-01 e aks-core-prod-brs-01. A stack da aplicação orders está desmarcada e não roda. Cada stack grava em um tfstate próprio, nomeado como o recurso, no mesmo container do Azure Storage." loading="lazy" />
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

## O exemplo: três stacks

Nos exemplos, uso uma plataforma com três stacks: a rede (`vnet-core`), o cluster (`aks-core`) e uma aplicação (`app-orders`), com o banco dedicado dela. A arquitetura em si (rede privada, Private Endpoints, Argo CD) e o código de cada stack estão na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/). Aqui importa só como dividir, nomear e acionar.

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
| *(fora do Terraform)* | O pod `orders` e o Argo CD | Manifestos em `infra/argocd` ([Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/)) | não tem state |

Dois detalhes. O módulo `private-endpoint` é usado por duas stacks, e esse é o tipo de reaproveitamento que justifica um módulo: o guia de refatoração da HashiCorp recomenda agrupar em módulo o conjunto de recursos que você cria em várias configurações. E a stack `aks-core` também guarda o ACR: ela leva o nome do recurso principal, e o registry é apoio.

### O banco é da aplicação

O PostgreSQL é dedicado à aplicação e entra como uma chamada de módulo na stack dela, não numa stack compartilhada de "dados". O ciclo de vida do banco acompanha o da aplicação, e tamanho, SKU e storage são parâmetros da chamada. É uma escolha minha, com prós e contras que detalho na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/). O pod da aplicação, por sua vez, **não** é um recurso Terraform: ele entra no cluster por GitOps, também na Parte 2.

---

## Como o repositório e o state se organizam

### Estrutura do repositório

```text
infra/
├── modules/                  # peças reutilizáveis, sem state próprio
│   ├── network/
│   ├── private-endpoint/
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
├── scripts/
│   └── tf.sh
└── pipelines/
    ├── azure-pipelines.yml
    └── templates/
        └── terraform-stack.yml
```

Na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/) entram a pasta `argocd/` e o script de bootstrap.

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

Por que `>= 1.12` e `>= 4.65`: a autenticação OIDC do backend no Azure DevOps só aparece na [documentação do backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) a partir do Terraform 1.12, e a Parte 2 usa atributos do provider que chegaram depois do 4.0 (`rbac_authorization_enabled` no Key Vault e `user_assigned_identity_id` na credencial federada). Um `~> 1.9` ou `~> 4.0` aceitaria versões sem eles.

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

O código de cada stack e dos módulos está na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/). Um detalhe do exemplo de PostgreSQL do provider: ele usa `depends_on` no link entre a zona DNS e a VNet. Na divisão em stacks, esse `depends_on` vira **ordem de execução**: a `vnet-core` roda antes. É o que o `dependsOn` do pipeline garante, logo abaixo.

---

## Parâmetros no pipeline

Agora o centro do artigo. O pipeline recebe um parâmetro por etapa, e só as etapas marcadas rodam. As etapas são as três stacks Terraform. Na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/) eu acrescento uma quarta, o bootstrap do Argo CD.

### Azure DevOps

O Azure Pipelines tem [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): você declara tipo, valor padrão e, se quiser, uma lista de valores permitidos, e a tela de **Run pipeline** monta o formulário. Para o que a gente quer, três tipos resolvem: `string` com `values` (lista de opções), `boolean` (checkbox) e `object` (estruturas mais ricas).

```yaml
# infra/pipelines/azure-pipelines.yml
trigger: none   # execução sempre intencional; ver "Armadilhas"

variables:
  - group: tfstate   # TFSTATE_RG e TFSTATE_SA (onde fica o state)

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
          name: agentes-privados   # self-hosted, dentro da VNet (ver Parte 2)
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

O que importa nesse desenho:

- **Uma service connection por ambiente** (`sc-terraform-prod`), com federação de identidade, em vez de credenciais guardadas.
- **O pool `agentes-privados` fica dentro da VNet**, porque o ACR (e, se você fechar, o state) não aceita acesso público e a API do cluster é privada (detalhes na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/)).
- **O endereço do state vem de um variable group** (`tfstate`, com `TFSTATE_RG` e `TFSTATE_SA`). Sem ele, o `set -u` do script para no `init`.
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
ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"   # assinatura do ambiente (em duas linhas para o set -e pegar falha do az)
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
    echo "uso: tf.sh <plan|apply> <stack> <env> <instance>" >&2
    exit 2
    ;;
esac
```

> **Nota sobre a autenticação no Azure DevOps.** A task [`AzureCLI@2`](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2) expõe `$servicePrincipalId` e `$tenantId` quando `addSpnToEnvironment: true` e a service connection usa federação. Para o **backend**, a [doc do `azurerm`](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) diz que os endpoints do token OIDC são achados automaticamente no Azure DevOps. Para o **provider**, o [guia de OIDC](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_oidc) usa `SYSTEM_ACCESSTOKEN` e `SYSTEM_OIDCREQUESTURI` (por isso o `env:` das tasks) e exige o ID da service connection em `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID`. Reaproveitar o `AZURESUBSCRIPTION_SERVICE_CONNECTION_ID` nessa variável tem apoio na própria doc do backend: a partir do Terraform 1.12, ela diz que as tasks `AzureCLI` e `AzurePowerShell` definem essa variável automaticamente.

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
    runs-on: [self-hosted, linux, vnet-privada]   # runner dentro da VNet (ver Parte 2)
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

## Armadilhas que eu já vi acontecer

1. **Parâmetro não é cofre.** A Microsoft avisa que os valores dos parâmetros são expandidos na montagem do template e podem aparecer em logs. A pesquisa [*The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) (Rahman, Parnin e Williams, ICSE 2019) analisou 15.232 scripts de IaC, achou 21.201 *security smells* (1.326 deles senhas hardcoded) e mostrou que um segredo hardcoded pode persistir por até 98 meses. Guarde credenciais em variáveis secretas ou no Key Vault, e restrinja os valores permitidos dos parâmetros.
2. **Seleção parcial gera drift.** Se alguém marca só o cluster depois de uma mudança de rede que não foi aplicada, o plano falha ou, pior, roda sobre uma base desatualizada. Eu uso `plan` como ação padrão e uma rotina agendada que roda `plan` em tudo para detectar drift.
3. **Ordem de execução e de destruição.** Na criação: `vnet-core`, `aks-core` e `app-orders`. No `destroy` é o inverso, e o banco guarda dados. Por isso eu não ofereço `destroy` como valor de `action` em `prod`.
4. **Quem pode clicar em "Run" é parte do controle de acesso.** O formulário de parâmetros é uma interface de controle da infraestrutura: restrinja quem executa o pipeline e proteja o Environment de produção. E, se ligar um `trigger`, lembre que o run automático usa os valores padrão (por isso o `trigger: none` e o `default: false`).
5. **Dividir demais.** Vinte states pequenos viram vinte pontos de dependência. Divida por ciclo de vida e por dono, não por tamanho (o critério do Parnas, de novo).
6. **Rede privada também fecha a porta do seu pipeline.** Se o ACR ou a conta do state não aceitam acesso público, o agente hospedado pela Microsoft não os alcança. Planeje o agente ou runner self-hosted dentro da VNet desde o começo (a [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/) mostra o porquê).

---

## Prós, contras e quando eu não usaria

**Prós**

- Blast radius menor e mudanças mais fáceis de revisar.
- Permissão mínima por stack, por ambiente e por aplicação.
- Planos mais rápidos e sem disputa de lock.
- Um pipeline para manter, com o mesmo código em todas as instâncias.
- Módulos reaproveitados entre stacks.
- Nomes que dizem o que cada recurso e cada state guardam.

**Contras**

- Mais peças para entender: módulos, stacks, backends, templates.
- Dependências entre stacks ficam explícitas e são sua responsabilidade.
- Migrar de um state grande exige planejamento. O [guia de refatoração](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) manda rodar `terraform plan` na configuração de origem e confirmar que nada vai mudar.
- A seleção manual abre espaço para erro humano sem guard rails (approvals, valores permitidos, `plan` como padrão).

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
- [ ] Aprovação no Environment de produção
- [ ] `plan` salvo e aplicado como artefato
- [ ] Agentes ou runners self-hosted dentro da VNet, se a rede é privada
- [ ] Rotina agendada de `plan` para detectar drift
- [ ] Documentar a ordem de dependência entre as etapas

---

## FAQ

**Por que não um state só, com `-target`?**
Eu já vi quem tentasse: um state, e um parâmetro passando `-target=module.aks`. A [documentação do Terraform](https://developer.hashicorp.com/terraform/cli/commands/plan) diz para usar `-target` só em circunstâncias excepcionais (como se recuperar de erros) e que não é recomendado para operações de rotina. Ele não resolve o lock, o tempo de refresh, o blast radius nem a separação de permissões. É o checkbox sem a metade do desenho.

**Posso usar `object` ou `stringList` em vez de vários booleanos no Azure DevOps?**
Pode. O `object` permite iterar com `${{ each }}`, e o `stringList` deixa marcar vários itens numa lista, mas a doc avisa que ele não está disponível em templates. O custo é uma entrada menos amigável que checkboxes e dependências mais trabalhosas de montar. Eu não testei essas variações. Para poucas etapas, prefiro booleanos, e para rodar tudo de uma vez basta marcar todos.

**Isso funciona com Bicep ou OpenTofu?**
O desenho de parâmetros, stacks independentes e pipeline único serve para qualquer IaC. O específico do Terraform aqui é o `tfstate` e o backend. O OpenTofu usa o mesmo modelo de backend `azurerm`, mas confirme as particularidades na documentação dele.

**Como migro de um state único?**
Planeje o agrupamento, mova os recursos com blocos `removed` e `import` (o guia de refatoração da HashiCorp detalha), e confirme que o `terraform plan` não mostra mudanças em nenhuma das stacks. Comece em dev.

---

## Fechando

O checkbox no pipeline é só a ponta visível. O que sustenta a ideia é o desenho por baixo: módulos que concentram o *como*, stacks que isolam o *o quê*, states que isolam o *impacto*, nomes que dizem o que cada coisa é e identidades que isolam o *quem pode*. Com isso pronto, o parâmetro vira só a forma de escolher.

Se você só tem um state hoje, não precisa dividir tudo de uma vez. Escolha a parte que mais dói e comece por ela. Na [Parte 2](/blog/pt-br/2026-11-22/aks-postgresql-rede-privada-terraform-argocd/) eu mostro a arquitetura por trás dos exemplos: AKS e PostgreSQL em rede privada, com deploy por Argo CD. E, se você já fez essa divisão de outro jeito, eu gostaria de saber o que funcionou e o que não funcionou no seu caso.

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
