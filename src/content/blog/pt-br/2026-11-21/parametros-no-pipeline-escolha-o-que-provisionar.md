---
title: "Parâmetros no pipeline: escolha o que provisionar (Terraform, vários tfstate e módulos)"
description: "Como usar parâmetros no YAML do Azure DevOps e do GitHub Actions para selecionar quais stacks Terraform rodam, por que separar o state e quais padrões e pesquisas sustentam essa decisão."
pubDate: 2026-11-21
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "Cloud & DevOps"
tags: ["terraform", "azure-devops", "github-actions", "iac", "tfstate", "modulos", "platform-engineering", "azure"]
readingTime: "18 min"
lang: "pt"
draft: true
---

> **O que você vai encontrar aqui**
> - Como transformar o pipeline em um "painel" onde você marca o que quer provisionar
> - Por que isso só funciona bem com vários `tfstate` e módulos, e não com um state gigante
> - O mesmo desenho em Azure DevOps e em GitHub Actions, com YAML
> - Em quais padrões, documentações e pesquisas essa abordagem se apoia (com link)
> - Prós, contras e as armadilhas que eu já vi acontecer

---

## O problema que me fez chegar nisso

Todo time de infraestrutura passa por uma fase parecida. Começa com um repositório Terraform, um `main.tf` e um pipeline que roda `terraform apply`. Funciona muito bem até o dia em que o arquivo cresce: rede, banco, cluster, Key Vault, monitoramento, tudo no mesmo state.

Aí aparecem os sintomas, e eu já vivi todos:

- Você só queria subir uma subnet nova, mas o `plan` leva 12 minutos porque refresca 600 recursos.
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

### 1. Blast radius menor

A própria HashiCorp diz, nas [boas práticas de workspaces](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices), que qualquer operação em um recurso pode afetar os outros recursos gerenciados no mesmo state, e que o ideal é manter o raio de impacto pequeno. A orientação é separar por ciclo de vida (o que muda sempre fica longe do que quase nunca muda), por stateful versus stateless (banco de dados longe de computação) e por responsabilidade de times e permissões. Isso aparece também no guia de [refatoração de state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor).

Na prática: errar um `apply` na stack de aplicação não coloca a rede nem os dados na linha de tiro.

### 2. Menos privilégio

Com states separados, cada stack pode rodar com uma identidade diferente, com a permissão mínima de que ela precisa. A rede pede `Network Contributor` no escopo dela. A stack de dados pede outro conjunto. O pipeline que roda tudo com `Owner` na subscription deixa de ser necessário.

### 3. Feedback mais rápido

`plan` menor, `apply` menor, lock menor. No backend `azurerm` o lock usa recursos nativos do Azure Blob Storage ([documentação do backend](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)), e como cada stack é um blob com a sua `key`, ninguém espera ninguém. Isso também é descrito na [documentação da Microsoft](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend).

### 4. Mudanças pequenas e frequentes

O Azure Well-Architected Framework, no item [OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments), recomenda práticas de deploy seguras com foco em releases pequenos e incrementais, com quality gates e exposição progressiva. Selecionar só o que mudou é a versão de infraestrutura dessa ideia.

### 5. Um pipeline para manter, não dez

Em vez de `pipeline-network.yml`, `pipeline-data.yml`, `pipeline-aks.yml` com 90% de código igual, existe um template de stack e um orquestrador. Corrigiu um problema de autenticação uma vez, corrigiu para todas.

---

## Em que padrões e pesquisas isso se apoia

Eu não inventei nada disso, e acho importante deixar claro de onde vem. Segue o que consegui confirmar nas fontes, com a ressalva de onde a ligação é uma analogia minha e não uma conclusão do autor.

| Referência | O que ela diz | Como se conecta |
|---|---|---|
| [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices) | Manter o blast radius pequeno; separar por ciclo de vida, stateful/stateless e responsabilidade | Fundamenta a divisão em vários `tfstate` |
| [HashiCorp — Refactor state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor) | Planejar o agrupamento e as dependências antes de dividir; usar blocos `removed` e `import` | Mostra como migrar de um state grande para vários sem destruir nada |
| [Azure Landing Zones](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy) | Landing zone de plataforma separada das landing zones de aplicação, por ambiente | Mesma lógica: o que é compartilhado muda menos e tem outro dono |
| [Azure Well-Architected, OE:11](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments) | Deploys pequenos, incrementais, via pipeline, com os mesmos artefatos em todos os ambientes | Um pipeline, parâmetros diferentes |
| [Twelve-Factor App, III. Config](https://12factor.net/config) | Config é o que varia entre deploys e fica separada do código | Ambiente e seleção de stack são *config*, o código dos módulos é o mesmo |
| [Parnas (1972), *On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623) | A eficácia de uma modularização depende do critério usado para dividir o sistema | Base teórica clássica para "dividir pelo critério certo". É uma analogia: o artigo é sobre software, não sobre IaC |
| [Rahman, Parnin e Williams (ICSE 2019), *The Seven Sins*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts) | Analisaram 15.232 scripts de IaC e encontraram 21.201 ocorrências de *security smells*, 1.326 delas senhas hardcoded | Motivo para tratar parâmetro como seleção e nunca como lugar de segredo |
| [State of DevOps 2021 (DORA)](https://cloud.google.com/resources/state-of-devops) | Mede entrega por lead time, frequência de deploy, tempo de restauração e taxa de falha em mudanças | São as métricas que melhoram quando as mudanças ficam pequenas e isoladas |

Sobre o DORA, um cuidado: eu não estou dizendo que "parâmetros de pipeline" aparecem como um achado da pesquisa. O que a pesquisa mede são essas quatro métricas, e o argumento é que mudanças menores e mais isoladas ajudam justamente nelas. Quem quiser a base, o livro *Accelerate* (Forsgren, Humble e Kim) agrupa as capacidades de entrega contínua.

---

## O exemplo: Terraform com vários tfstate e módulos

### Estrutura do repositório

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

A regra que eu sigo:

- **Módulo** é o *como*: uma receita reutilizável de rede, de AKS, de banco. Não tem backend nem state.
- **Stack** é o *o quê e onde*: uma raiz Terraform que chama módulos, tem backend próprio e é o que o pipeline executa.
- **Ambiente** é só dado: um `.tfvars` e uma `key` diferente no backend.

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

Duas coisas que valem a atenção. A conta do state deve ficar fora do que o Terraform gerencia nas stacks, e a autenticação deve ser por Microsoft Entra ID e não por access key (a [documentação](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm) trata Entra ID como a opção recomendada, exigindo `Storage Blob Data Contributor` no container).

### Módulo chamado pela stack

```hcl
# infra/stacks/30-aks/main.tf (continuação)
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

Repare que a stack de AKS **não lê o state da stack de rede**. Ela consulta a rede pela API do Azure com um `data source`. Isso é uma decisão consciente, e eu volto nela mais adiante.

Se os módulos vivem em outro repositório, o `source` aponta para uma tag, para a versão ficar travada: `git::https://.../modules.git//aks?ref=v1.4.0`.

---

## Azure DevOps: parâmetros em tempo de execução

O Azure Pipelines tem [runtime parameters](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/runtime-parameters): você declara o parâmetro com tipo, valor padrão e, se quiser, uma lista de valores permitidos, e a tela de **Run pipeline** monta o formulário para você. Para o que a gente quer, três tipos resolvem: `string` com `values` (vira lista de opções), `boolean` (vira checkbox) e `object` (para estruturas mais ricas).

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
    displayName: "20 · Dados"
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

O ponto central está nas expressões `${{ if ... }}`. Elas são **expressões de template**, avaliadas quando o pipeline é montado (a documentação de [template expressions](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/template-expressions) explica que elas são resolvidas na inicialização). Quer dizer: o stage da stack desmarcada **não existe** no run. Não aparece "skipped", não consome agente, simplesmente não está lá.

O `dependsOn` condicional resolve um detalhe chato: se você declarar dependência de um stage que não foi incluído, o pipeline falha na validação. Aqui a dependência só existe quando a stack de rede também foi selecionada.

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

O que está acontecendo:

- Uma **service connection por ambiente** (`sc-terraform-dev`, `sc-terraform-prd`), idealmente com federação de identidade. Nada de segredo guardado.
- O job `deployment` usa um **Environment** do Azure DevOps. É nele que você configura as aprovações e checks do `prd`. Quem aprova o `apply` de produção é decisão do Environment, não do YAML.
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

Os valores `TFSTATE_RG` e `TFSTATE_SA` podem vir de variáveis do pipeline. O `$servicePrincipalId`, o `$tenantId` e o `$idToken` são expostos pela task `AzureCLI@2` quando `addSpnToEnvironment: true` e a service connection usa federação. Confirme esse comportamento na versão da task que você usa, porque é uma área que a Microsoft vem mexendo.

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
        description: "20 · Dados"
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

Aqui tem uma diferença importante em relação ao Azure DevOps. No GitHub a condição é avaliada **em tempo de execução**, então o job desmarcado aparece como *skipped*. E quando um `needs` é pulado, o job dependente também seria pulado por padrão. O `!cancelled() && !failure()` resolve isso: "rode se nada falhou, mesmo que a dependência tenha sido pulada".

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

Os pontos que fazem diferença:

- Os [workflows reutilizáveis](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) são chamados no nível do job, recebem `inputs` com `with`, e o tipo precisa bater com o declarado. Existe um limite de 20 chamadas de workflows reutilizáveis por arquivo, contando as aninhadas.
- A autenticação é por **OIDC**. O `ARM_USE_OIDC` faz o provider pedir o token ao GitHub e trocar por acesso no Azure, sem nenhum segredo armazenado. A [documentação do GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) mostra o fluxo.
- Quando o job usa um Environment, o *subject* do token fica no formato `repo:ORG/REPO:environment:NOME`. Isso permite criar **uma credencial federada por ambiente** no Entra ID: o `prd` só aceita tokens de jobs do Environment `prd`. É privilégio mínimo e separação por ambiente praticamente de graça. O GitHub também passou a oferecer um subject imutável (com os IDs do dono e do repositório) para repositórios novos, e a [Microsoft recomenda migrar](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects) credenciais baseadas em nome; vale conferir como isso afeta o seu repositório.
- Neste exemplo, `plan` e `apply` rodam no mesmo job, aplicando o plano salvo. O custo é que, se o Environment tiver *required reviewers*, a aprovação é pedida **antes** do plan. Se isso incomoda, use dois Environments (`dev-plan` e `dev-apply`, por exemplo) ou separe em dois jobs.

---

## Comparando os dois

| Ponto | Azure DevOps | GitHub Actions |
|---|---|---|
| Parâmetro do run | `parameters` com `type` e `values` | `workflow_dispatch.inputs` (`choice`, `boolean`, `environment`, `string`) |
| Quando a seleção é aplicada | Montagem do pipeline: o stage nem existe | Execução: o job aparece como skipped |
| Aprovação | Environment com approvals e checks | Environment com required reviewers |
| Reuso | Templates (`template:`) | Workflows reutilizáveis (`workflow_call`) |
| Autenticação | Service connection com federação | OIDC com credencial federada por Environment |
| Limite que me pegou | Parâmetros não valem para runs disparados por trigger (usa o `default`) | 25 inputs por `workflow_dispatch`; 20 chamadas de workflows reutilizáveis |

Nenhum é melhor em tudo. A diferença de "stage inexistente versus job skipped" parece detalhe, mas muda como você lê o histórico de execuções e como configura dependências.

---

## Por que não um state só, com `-target`?

Eu já vi quem tentasse o caminho oposto: um state só, e parâmetro passando `-target=module.aks`. Não recomendo como rotina. A própria documentação do Terraform trata o `-target` como recurso para situações excepcionais, não como fluxo normal. Ele não resolve o lock, o tempo de refresh, o blast radius no state nem a separação de permissões. É o checkbox sem a metade do desenho.

---

## Entre stacks: `terraform_remote_state` ou data source?

Quando uma stack depende de outra, tem duas formas de ler a informação:

- `terraform_remote_state`: lê os outputs do state da outra stack. É direto, mas quem lê precisa de acesso ao arquivo de state inteiro (que pode conter dados sensíveis) e você acopla uma stack ao formato do state da outra.
- **Data source do provider**: consulta o recurso real pela API do Azure. Exige uma convenção de nomes, mas dá um acoplamento mais fraco e não precisa liberar acesso a state alheio.

Eu prefiro o data source por padrão e uso o `remote_state` quando preciso de um output que não existe como recurso consultável. Essa preferência é minha, baseada em experiência, não uma regra da HashiCorp, então avalie no seu contexto.

---

## Armadilhas que eu já vi acontecer

1. **Parâmetro não é cofre.** A Microsoft avisa que os valores dos parâmetros são expandidos na montagem do template e podem aparecer em logs. Segredo não vai em parâmetro. A pesquisa do ICSE 2019 citada lá em cima é um bom lembrete de como senha hardcoded em IaC é comum.
2. **Seleção parcial gera drift.** Se alguém marca só a stack de AKS depois de uma mudança de rede que não foi aplicada, o plano vai falhar ou, pior, ser aplicado sobre uma base desatualizada. Eu resolvo com `plan` como ação padrão e com uma rotina agendada que roda `plan` em tudo para detectar drift.
3. **Ordem de destruição.** Na criação, rede vem antes de cluster. No `destroy` é o inverso. Por isso eu simplesmente não ofereço `destroy` como valor de `action` em `prd`.
4. **Quem pode clicar em "Run" é parte do controle de acesso.** O formulário de parâmetros é uma interface de controle de infraestrutura. Restrinja quem pode executar o pipeline e proteja o Environment de produção.
5. **Dividir demais.** Vinte states pequenos viram vinte pontos de dependência. Divida por ciclo de vida e por dono, não por tamanho.
6. **Execuções por trigger usam o default.** Se você ligar o pipeline a um `trigger`, o run automático usa os valores padrão dos parâmetros. Por isso o `trigger: none` no exemplo e o `default: false` nas stacks.

---

## Prós e contras

**Prós**

- Blast radius menor e mudanças mais fáceis de revisar.
- Permissão mínima por stack e por ambiente.
- Planos mais rápidos e sem disputa de lock.
- Um único pipeline para manter, com o mesmo código em todos os ambientes.
- Histórico claro: o run registra o que foi selecionado.

**Contras**

- Mais peças para entender: módulos, stacks, backends, templates.
- Dependências entre stacks ficam explícitas e precisam ser gerenciadas por você.
- Migrar de um state grande exige planejamento (o [guia de split de state](https://support.hashicorp.com/hc/en-us/articles/7955227415059-How-to-Split-State-Files) da HashiCorp recomenda validar que o `plan` pós-divisão não mostra mudanças).
- A seleção manual abre espaço para erro humano se você não colocar guard rails (approvals, valores permitidos, `plan` como padrão).
- Divisão errada troca um problema por outro: acoplamento entre states.

---

## Checklist para começar

- [ ] Mapear recursos por ciclo de vida, dono e stateful/stateless antes de dividir
- [ ] Extrair módulos para o que se repete
- [ ] Uma stack por raiz Terraform, com `backend "azurerm" {}` vazio
- [ ] `key` = `<stack>/<ambiente>.tfstate`
- [ ] Autenticação por federação de identidade, sem segredo
- [ ] Parâmetros: `environment` com lista fechada, `action` com `plan` como padrão, um booleano por stack
- [ ] Aprovação no Environment de produção
- [ ] `plan` salvo e aplicado como artefato
- [ ] Rotina agendada de `plan` para detectar drift
- [ ] Documentar a ordem de dependência entre stacks

---

## FAQ

**Posso usar `object` em vez de vários booleanos no Azure DevOps?**
Pode, e dá para iterar com `${{ each }}`, o que reduz o YAML. O custo é que o formulário vira um campo de texto YAML em vez de checkboxes, então é mais fácil errar. Para poucas stacks, eu prefiro booleanos.

**E se eu quiser rodar todas as stacks de uma vez?**
Marque todas. Se isso for o caso mais comum, considere um parâmetro `all` ou um perfil de execução, mas mantenha a seleção individual disponível.

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
- [GitHub — Input types for manual workflows](https://github.blog/changelog/2021-11-10-github-actions-input-types-for-manual-workflows)
- [GitHub — workflow_dispatch agora aceita 25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
- [GitHub — Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub — OIDC no Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft Entra — Subjects imutáveis do GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [HashiCorp — Workspace best practices](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/best-practices)
- [HashiCorp — Refactor Terraform state](https://developer.hashicorp.com/terraform/language/v1.16.x/state/refactor)
- [HashiCorp — How to split state files](https://support.hashicorp.com/hc/en-us/articles/7955227415059-How-to-Split-State-Files)
- [HashiCorp — Backend azurerm](https://developer.hashicorp.com/terraform/language/v1.16.x/backend/azurerm)
- [Microsoft — Store Terraform state in Azure Storage](https://learn.microsoft.com/en-us/azure/terraform/terraform-backend)

**Padrões e boas práticas**
- [Azure Well-Architected — Safe deployment practices (OE:11)](https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments)
- [Azure Landing Zones — Deploy](https://learn.microsoft.com/en-us/azure/architecture/landing-zones/landing-zone-deploy)
- [Azure Landing Zones — Terraform design considerations](https://learn.microsoft.com/azure/architecture/landing-zones/terraform/landing-zone-terraform)
- [The Twelve-Factor App — III. Config](https://12factor.net/config)

**Pesquisa**
- D. L. Parnas, [*On the Criteria To Be Used in Decomposing Systems into Modules*](https://doi.org/10.1145/361598.361623), Communications of the ACM, 15(12), 1972.
- A. Rahman, C. Parnin, L. Williams, [*The Seven Sins: Security Smells in Infrastructure as Code Scripts*](https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts), ICSE 2019.
- [Accelerate State of DevOps 2021 (DORA)](https://cloud.google.com/resources/state-of-devops)
- N. Forsgren, J. Humble, G. Kim, *Accelerate*, IT Revolution, 2018.
