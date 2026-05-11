---
title: "Como eu uso o CLAUDE.md no dia a dia"
description: "Uma abordagem prática de hierarquia de contextos com CLAUDE.md aplicada ao mundo DevOps: contexto global, por repositório e por componente — reutilizando o que importa e isolando o que é específico."
pubDate: 2026-05-10
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "AI & MLOps"
tags: ["claude", "claude-code", "ia", "devops", "platform-engineering", "terraform", "kubernetes", "github-actions", "azure"]
readingTime: "14 min"
lang: "pt"
draft: false
---

> **O que você vai encontrar aqui**
> - Como o Claude Code descobre e carrega arquivos `CLAUDE.md`
> - A estrutura em três camadas que uso: global → repositório → componente
> - Exemplos reais de pipelines CI/CD, IaC e Kubernetes
> - Benefícios reais, limitações honestas e comparação com outras estratégias
> - Links para a documentação oficial de cada conceito citado

---

## Índice

- [Contexto e motivação](#contexto-e-motivação)
- [Como o Claude Code lê os CLAUDE.md](#como-o-claude-code-lê-os-claudemd)
- [Minha estrutura em três camadas](#minha-estrutura-em-três-camadas)
  - [Camada 1 — Global](#camada-1--global)
  - [Camada 2 — Repositório](#camada-2--repositório)
  - [Camada 3 — Componente/subpasta](#camada-3--componentesubpasta)
- [Exemplo concreto](#exemplo-concreto)
- [Benefícios](#benefícios)
- [Limitações e cuidados](#limitações-e-cuidados)
- [Outras estratégias](#outras-estratégias)
- [FAQ](#faq)

---

## Contexto e motivação

Como engenheiro de Cloud & DevOps, meu dia a dia é uma mistura intensa de contextos: um momento estou escrevendo um módulo Terraform para provisionar AKS no Azure, no próximo estou debugando um pipeline do GitHub Actions com OIDC, e logo depois revisando manifests Kubernetes para um rollout com ArgoCD.

Quando comecei a usar o [Claude Code](https://docs.anthropic.com/pt/docs/claude-code/overview) com intensidade nesse ambiente, percebi que estava repetindo as mesmas instruções em toda conversa: convenções de nomenclatura de recursos Azure, a estrutura de módulos Terraform do time, qual versão do Kubernetes estávamos usando, o formato de variáveis de ambiente nos pipelines do Azure DevOps...

O problema clássico de qualquer ferramenta baseada em contexto de janela: **o que não está no contexto, o modelo não sabe**. E recriar esse contexto manualmente a cada sessão é caro, lento e propenso a erro — especialmente quando você trabalha com múltiplos repositórios de infraestrutura ao mesmo tempo.

A solução que o próprio Claude Code oferece são os arquivos `CLAUDE.md` — documentos Markdown carregados automaticamente que definem regras, convenções e comportamentos esperados. A chave é entender *como* aproveitá-los em camadas para que o assistente já saiba que você usa `azurerm` como provider Terraform, que seus clusters Kubernetes rodam na versão 1.31, e que todo pipeline precisa de aprovação manual antes de `apply` — sem você precisar repetir isso toda vez.

---

## Como o Claude Code lê os CLAUDE.md

Antes de falar da minha estrutura, é essencial entender o mecanismo oficial.

O Claude Code carrega arquivos `CLAUDE.md` de **múltiplos locais, em ordem de precedência crescente**:

| Localização | Quando é carregado |
|---|---|
| `~/.claude/CLAUDE.md` | Sempre — contexto global do usuário |
| `<raiz-do-repo>/CLAUDE.md` | Quando você trabalha em qualquer arquivo do repositório |
| `<subpasta>/CLAUDE.md` | Quando você trabalha em arquivos *dentro* daquela subpasta |

Isso significa que os contextos se **somam**: o global é base, o repositório adiciona especificidades do projeto, e subpastas refinam ainda mais para um componente concreto.

> **Referência oficial:** [Anthropic Docs — CLAUDE.md](https://docs.anthropic.com/pt/docs/claude-code/memory#claudemd-files)

Além dos `CLAUDE.md`, você pode usar a sintaxe `@filename` dentro de qualquer um deles para incluir o conteúdo de outros arquivos — o equivalente a um `import` de contexto.

```markdown
<!-- Dentro de CLAUDE.md -->
@.claude/conventions/terraform-style.md
@.claude/conventions/kubernetes-naming.md
@.claude/conventions/pipeline-standards.md
```

Isso é especialmente útil para repositórios de plataforma onde as convenções são extensas — você mantém cada convenção em um arquivo dedicado e referencia apenas o que é relevante para cada componente.

> **Referência oficial:** [Anthropic Docs — @ imports](https://docs.anthropic.com/pt/docs/claude-code/memory#importing-files-with-)

---

## Minha estrutura em três camadas

### Camada 1 — Global

**Arquivo:** `~/.claude/CLAUDE.md`

Este é o arquivo que se aplica a *tudo* — qualquer projeto, qualquer repositório, qualquer sessão. Aqui eu coloco apenas o que é verdade para 100% dos meus contextos de trabalho:

```markdown
# Contexto Global — Felipe Rezende

## Identidade e idioma
- Sou brasileiro. Responda sempre em português, salvo quando o código,
  manifests YAML ou convenções de ferramentas exigirem inglês.
- Comentários em código shell/bash e HCL: inglês.
- Documentação e mensagens de commit: português.

## Estilo de commit
- Siga o padrão Conventional Commits: feat, fix, docs, chore, refactor...
- Mensagem no imperativo, máximo 72 chars no subject.
- Exemplos: `feat(aks): adiciona node pool spot`, `fix(pipeline): corrige gate de aprovação`

## Princípios gerais de IaC
- Prefira módulos reutilizáveis a recursos inline repetidos.
- Todo recurso gerenciado deve ter tags obrigatórias: environment, owner, cost-center.
- Valide com `terraform validate` e `tflint` antes de qualquer PR.
- Jamais use `terraform apply` direto sem um plano salvo (`-out=tfplan`).

## Segurança
- Nunca escreva segredos, tokens ou connection strings hardcoded.
- Secrets vão para Azure Key Vault ou como Kubernetes Secrets (preferencialmente
  gerenciados pelo External Secrets Operator).
- Identifique e aponte violações de CIS Benchmark quando relevante.
- Em pipelines, prefira OIDC/Workload Identity a credenciais de longa duração.
```

Repare: aqui **não** há menção a qual versão do Terraform usar, qual subscription Azure, qual cluster Kubernetes. O global é o denominador comum — regras que valem independentemente de qual repositório estou abrindo.

---

### Camada 2 — Repositório

**Arquivo:** `<repo>/.claude/CLAUDE.md`

Eu prefiro colocar dentro de `.claude/` para não poluir a raiz do repositório:

```
platform-infra/
  .claude/
    CLAUDE.md                    ← contexto do repositório
    agents/
      iac-reviewer.md            ← revisa Terraform/Bicep seguindo padrões do time
      pipeline-debugger.md       ← analisa falhas em GitHub Actions / Azure DevOps
      k8s-manifest-writer.md     ← gera manifests com as convenções do cluster
    commands/
      /plan-summary.md           ← resume o output do terraform plan em pt-BR
      /pr-infra.md               ← gera descrição de PR para mudanças de infraestrutura
      /argo-sync-check.md        ← verifica status de sincronização do ArgoCD
  modules/
    aks/
    networking/
    keyvault/
  environments/
    dev/
    staging/
    prod/
  pipelines/
    .github/workflows/
    azure-pipelines/
```

O `CLAUDE.md` do repositório define tudo que é específico deste repositório de plataforma:

```markdown
# Contexto — Repositório de Infraestrutura de Plataforma

## Stack e versões
- Terraform >= 1.9 com backend no Azure Blob Storage
- Provider azurerm ~> 4.0
- Kubernetes 1.31 (AKS, canal Stable)
- Helm 3.x para charts de plataforma
- ArgoCD 2.13 para GitOps de aplicações

## Estrutura de módulos Terraform
- `modules/` → módulos internos reutilizáveis (sem estado próprio)
- `environments/<env>/` → configurações por ambiente (tfvars + backend config)
- Cada módulo deve ter `README.md`, `variables.tf`, `outputs.tf` e `main.tf`
- Não crie recursos fora de módulos; sempre encapsule.

## Convenções de nomenclatura Azure
- Padrão: `<tipo>-<projeto>-<ambiente>-<região>`
- Exemplos: `aks-platform-prod-eastus2`, `rg-platform-prod-eastus2`
- Abreviações de região: eastus2 → `eus2`, brazilsouth → `brs`

## CI/CD
- GitHub Actions para IaC (Terraform): OIDC com Federated Identity no Azure AD
- Azure DevOps Pipelines para deploys de aplicação
- Todo `terraform apply` em produção exige aprovação manual via Environment Protection Rules
- Workflow padrão: `terraform fmt → validate → tflint → plan → (aprovação) → apply`

## GitOps com ArgoCD
- Apps declaradas em `gitops/apps/` como ApplicationSets
- Estratégia: sync automático em dev/staging, manual em prod
- Helm values por ambiente em `gitops/values/<env>/`

## O que NÃO fazer
- Não use `count` para criar recursos com identidades diferentes — use `for_each`.
- Não commite arquivos `.tfstate` ou `.tfplan` — estão no `.gitignore`.
- Não use `latest` como tag de imagem em manifests de produção.
- Não exponha recursos Azure sem NSG ou Private Endpoint.
```

#### Agents e Commands por repositório

Dentro de `.claude/agents/` e `.claude/commands/`, defino comportamentos reutilizáveis **no escopo deste repositório de plataforma**:

```markdown
<!-- .claude/agents/iac-reviewer.md -->
# Agent: Revisor de IaC

Você é um revisor experiente de infraestrutura como código.
Ao revisar Terraform ou Bicep neste repositório:
- Verifique se todos os recursos têm as tags obrigatórias (environment, owner, cost-center)
- Aponte uso de `count` onde `for_each` seria mais adequado
- Verifique se módulos novos têm README e outputs declarados
- Sinalize recursos expostos publicamente sem justificativa
- Valide nomes de recursos contra o padrão `<tipo>-<projeto>-<ambiente>-<região>`
```

```markdown
<!-- .claude/commands/plan-summary.md -->
# Comando: /plan-summary

Receba o output de `terraform plan` e produza um resumo em português com:
1. Quantos recursos serão criados / modificados / destruídos
2. Mudanças de alto risco (destruições, mudanças de ID, alterações em networking)
3. Estimativa de impacto em custo (se visível no plan)
4. Recomendação: safe to apply / requer revisão humana
```

> **Referência oficial:** [Anthropic Docs — Custom Slash Commands](https://docs.anthropic.com/pt/docs/claude-code/slash-commands)  
> **Referência oficial:** [Anthropic Docs — Sub-agents](https://docs.anthropic.com/pt/docs/claude-code/sub-agents)

---

### Camada 3 — Componente/subpasta

Esta camada é usada quando um componente tem complexidade suficiente para merecer contexto próprio. No mundo DevOps, isso acontece frequentemente:

- O módulo Terraform de AKS tem parâmetros e decisões de design que o módulo de networking não tem
- A pasta de pipelines do GitHub Actions segue convenções diferentes da pasta de Azure DevOps Pipelines
- Os manifests Kubernetes de uma aplicação crítica têm restrições de segurança específicas

**Exemplo: módulo Terraform de AKS**

**Arquivo:** `modules/aks/CLAUDE.md`

```markdown
# Módulo Terraform — AKS

## Propósito
Provisiona clusters AKS com configurações padronizadas para produção:
private cluster, Azure CNI Overlay, Workload Identity habilitado.

## Variáveis obrigatórias
- `cluster_name`: segue o padrão do repositório
- `kubernetes_version`: deve estar no canal Stable (atualmente 1.31)
- `node_pools`: mapa de objetos — não use lista para facilitar o for_each
- `log_analytics_workspace_id`: obrigatório, sem exceção

## Decisões de design
- Sempre habilite `oidc_issuer_enabled` e `workload_identity_enabled`
- Node pool de sistema: Standard_D4ds_v5 mínimo (4 vCPU, 16 GB)
- Node pool de usuário: configurável, mas defina `taints` para isolar cargas
- Não use managed identity por cluster — use pod-level com Workload Identity

## Outputs esperados
Exporte sempre: `cluster_id`, `kube_config`, `oidc_issuer_url`,
`kubelet_identity_object_id`

## Testes
- Testes de módulo em `tests/aks/` usando Terratest (Go)
- Execute localmente com: `cd tests/aks && go test -v -timeout 60m`
```

**Exemplo: pipelines GitHub Actions**

**Arquivo:** `pipelines/.github/workflows/CLAUDE.md`

```markdown
# Contexto — GitHub Actions Workflows

## Padrões deste repositório
- Todo workflow começa com `on: pull_request` + `on: push: branches: [main]`
- Use `permissions: id-token: write` para OIDC — nunca armazene CLIENT_SECRET
- Steps de login Azure: sempre `azure/login@v2` com `client-id`, `tenant-id`,
  `subscription-id` via vars (não secrets para os IDs públicos)
- Ambientes de produção usam `environment: production` com required reviewers

## Secrets e variáveis
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: GitHub Vars (não secrets)
- `TF_STATE_RESOURCE_GROUP`, `TF_STATE_STORAGE_ACCOUNT`: GitHub Vars
- Nenhuma senha ou token deve aparecer em `env:` inline — use `secrets.*`

## Estrutura de jobs
```yaml
jobs:
  validate:
    # fmt, validate, tflint
  plan:
    needs: validate
    # terraform plan -out=tfplan
  apply:
    needs: plan
    environment: production  # gate de aprovação
    # terraform apply tfplan
```

## Reusable Workflows
- Workflows reutilizáveis ficam em `.github/workflows/reusable/`
- Chame com `uses: ./.github/workflows/reusable/terraform-plan.yml`
```

---

## Exemplo concreto

Cenário real: estou editando `modules/aks/main.tf` para adicionar suporte a node pools spot.

O Claude Code carrega, nesta ordem:

1. `~/.claude/CLAUDE.md` → idioma, commits, princípios de IaC, segurança
2. `platform-infra/.claude/CLAUDE.md` → versões (Terraform 1.9, azurerm 4.x, K8s 1.31), convenções de nomenclatura Azure, workflow de CI/CD
3. `platform-infra/modules/aks/CLAUDE.md` → variáveis obrigatórias, decisões de design do módulo, outputs esperados

Quando peço:

> "Adiciona suporte a node pools spot no módulo AKS. Use preemptible com fallback para on-demand."

O modelo já sabe:
- Usar `for_each` no mapa `node_pools` (não `count`)
- Que `kubernetes_version` deve ser `1.31`
- Que node pools precisam de `taints` para isolar cargas de trabalho
- Que os outputs `cluster_id` e `oidc_issuer_url` devem ser preservados
- Que o resultado precisa ser validado com `terraform validate` e `tflint`
- Para comentar o código em inglês e responder em português

Tudo isso sem eu escrever uma linha de instrução no prompt.

---

## Benefícios

### Consistência entre sessões e repositórios

Todos os repositórios de infraestrutura respeitam as mesmas tags obrigatórias, o mesmo padrão de nomenclatura Azure e as mesmas regras de pipeline — porque isso está no CLAUDE.md do repositório, não dependendo da minha memória.

### Onboarding de novos projetos de plataforma

Quando um novo repositório de infraestrutura é criado, copiamos o template `.claude/` com convenções base. O assistente já sabe as regras do time no primeiro commit.

### Agentes especializados por contexto

Um agent `iac-reviewer` num repositório Terraform sabe verificar tags, módulos e outputs. Um agent `pipeline-debugger` num repositório de workflows sabe analisar logs do GitHub Actions e do Azure DevOps. Cada um focado no seu domínio.

### GitOps para o próprio contexto

Os arquivos `.claude/` evoluem junto com o repositório via pull request. Quando a convenção de nomenclatura muda, o PR de refatoração inclui a atualização do `CLAUDE.md`. O histórico de contexto está no Git.

### Redução de erros em operações críticas

Quando o assistente já sabe que `terraform apply` em produção exige plano salvo e aprovação manual, ele não vai sugerir atalhos. O contexto é uma camada adicional de guardrail.

---

## Limitações e cuidados

### Limite de tokens

Repositórios de plataforma tendem a ter convenções extensas. Se o `CLAUDE.md` do repositório mais o do módulo mais o global somarem muitos tokens, você consome boa parte da janela de contexto antes de qualquer conversa.

**Prática recomendada:** use `@imports` para separar convenções em arquivos menores e carregar sob demanda. O `CLAUDE.md` principal aponta para os arquivos relevantes:

```markdown
# Contexto — platform-infra

@.claude/conventions/terraform-style.md
@.claude/conventions/azure-naming.md

<!-- Carregue apenas se relevante para o componente atual: -->
<!-- @.claude/conventions/kubernetes-manifests.md -->
```

### Conteúdo desatualizado

Atualizou o provider `azurerm` de `3.x` para `4.x`? O `CLAUDE.md` que dizia `~> 3.0` continuará gerando código da versão antiga até ser atualizado. Em IaC, isso pode gerar diferenças silenciosas.

**Prática recomendada:** adicione uma linha `# Atualizado em: YYYY-MM-DD` no topo e inclua a revisão do `CLAUDE.md` como item obrigatório nos PRs de upgrade de provider ou versão de Kubernetes.

### Não é memória persistente de conversas

O `CLAUDE.md` não sabe que você passou a última hora debugando um erro de quota de vCPU no Azure. Ele define *regras estruturais*, não o estado da sua sessão atual.

**Prática recomendada:** para tarefas longas de troubleshooting, mantenha um arquivo temporário com o estado atual e referencie-o com `@` no início da sessão.

### Conflitos entre camadas

O global diz "valide com tflint" mas o módulo específico tem uma configuração de tflint customizada. Camadas mais profundas geralmente prevalecem, mas não é explicitamente garantido.

**Prática recomendada:** no nível do componente, seja explícito sobre o que sobrescreve. Se o módulo de AKS usa uma config tflint diferente, declare isso claramente no seu `CLAUDE.md`.

### Informações sensíveis

Jamais coloque subscription IDs, tenant IDs, IPs internos, nomes de recursos de produção ou qualquer dado operacional sensível nos `CLAUDE.md`. Use placeholders como `<subscription-id>` e `<cluster-name>`.

---

## Outras estratégias

### System Prompts via API

Se você usa a API da Anthropic diretamente para automações (scripts de revisão de IaC, bots de pipeline etc.), o equivalente é o `system prompt`. Você pode injetar contexto dinamicamente — por exemplo, o output do `terraform plan` como parte do system prompt de um script de revisão automatizada.

> Referência: [Anthropic Docs — System Prompts](https://docs.anthropic.com/pt/docs/build-with-claude/system-prompts)

### Projects (Claude.ai)

No Claude.ai web, a funcionalidade [Projects](https://support.anthropic.com/pt/articles/9517075-what-are-projects) permite criar um espaço com instruções customizadas e documentos de conhecimento persistentes. Útil para discussões de arquitetura que não envolvem edição direta de código.

**Quando preferir Projects:** revisões de arquitetura, discussões de ADRs (Architecture Decision Records), quando você está num contexto de análise e não de edição de código.

### Cursor Rules (`.cursorrules`)

O [Cursor](https://www.cursor.com/en/features) usa um arquivo `.cursorrules` com propósito similar. A diferença é que o Cursor aplica esse contexto de forma transparente, enquanto o Claude Code lhe dá visibilidade explícita do que está sendo carregado — importante quando você quer auditar o que o assistente "sabe".

### Copilot Instructions (`.github/copilot-instructions.md`)

O [GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot) suporta instruções de repositório em `.github/copilot-instructions.md`. Uma vantagem: já está na pasta `.github/`, que em repositórios de plataforma costuma existir de qualquer forma.

### Comparativo rápido

| Estratégia | Escopo | Controle de versão | Hierarquia | Custo |
|---|---|---|---|---|
| `CLAUDE.md` (Claude Code) | Global + repositório + subpastas | ✅ | ✅ 3 camadas | Claude Max / API |
| Projects (Claude.ai) | Por projeto web | ❌ (na nuvem) | ❌ 1 camada | Claude Pro/Team |
| `.cursorrules` | Por repositório | ✅ | ❌ 1 camada | Cursor |
| `copilot-instructions.md` | Por repositório | ✅ | ❌ 1 camada | GitHub Copilot |

---

## FAQ

**Q: Preciso de um `CLAUDE.md` em *cada* módulo Terraform do meu repositório?**  
A: Não. Coloque apenas onde o contexto realmente diverge. Módulos simples (ex.: um resource group, um storage account) geralmente ficam cobertos pelas convenções do repositório. Reserve o CLAUDE.md de componente para módulos complexos com decisões de design não-óbvias, como AKS, networking hub-spoke ou módulos de identidade.

---

**Q: O `CLAUDE.md` funciona com outros editores além do VS Code?**  
A: Sim. O Claude Code carrega `CLAUDE.md` independentemente do editor — funciona no terminal, no VS Code, no JetBrains e em qualquer ambiente onde o `claude` CLI estiver instalado.

---

**Q: Posso usar o mesmo template `.claude/` para múltiplos repositórios de infraestrutura?**  
A: Não diretamente via symlink de forma nativa. A abordagem mais prática é manter um repositório de `platform-templates` com um diretório `.claude/` base, copiado ao criar novos repositórios. Use `@imports` para referenciar convenções compartilhadas de outro caminho se as equipes precisarem de sincronia contínua.

---

**Q: É seguro commitar o `.claude/` em repositórios de infraestrutura?**  
A: Sim, desde que você siga a regra: *nunca coloque IDs de subscription, tenant IDs, IPs internos, nomes de recursos de produção ou credenciais*. Use placeholders como `<subscription-id>`. O que deve ir para o `.claude/`: padrões de nomenclatura, versões de providers/ferramentas, decisões de design, convenções de pipeline.

---

**Q: Como integro o CLAUDE.md com workflows de revisão de IaC existentes?**  
A: O `CLAUDE.md` não substitui ferramentas como `tflint`, `checkov` ou `terrascan`. Ele complementa: enquanto as ferramentas automatizadas verificam regras estáticas, o contexto do CLAUDE.md permite ao assistente entender *por que* certas decisões foram tomadas e sugerir mudanças consistentes com a arquitetura do repositório.

---

**Q: Existe limite de tamanho para o CLAUDE.md?**  
A: Não há um limite explícito documentado, mas o conteúdo vai para a janela de contexto do modelo. Repositórios de plataforma com convenções extensas devem usar `@imports` para separar em arquivos menores, carregando só o necessário por componente.

---

## Referências

- [Claude Code — Visão Geral](https://docs.anthropic.com/pt/docs/claude-code/overview)
- [Claude Code — Memory e CLAUDE.md](https://docs.anthropic.com/pt/docs/claude-code/memory)
- [Claude Code — Slash Commands](https://docs.anthropic.com/pt/docs/claude-code/slash-commands)
- [Claude Code — Sub-agents](https://docs.anthropic.com/pt/docs/claude-code/sub-agents)
- [Claude.ai — Projects](https://support.anthropic.com/pt/articles/9517075-what-are-projects)
- [Anthropic — System Prompts](https://docs.anthropic.com/pt/docs/build-with-claude/system-prompts)
- [GitHub Copilot — Repository Instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)
- [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/)
- [Terraform — Módulos](https://developer.hashicorp.com/terraform/language/modules)
- [Azure Kubernetes Service — Documentação](https://learn.microsoft.com/pt-br/azure/aks/)
- [ArgoCD — Documentação](https://argo-cd.readthedocs.io/en/stable/)
- [GitHub Actions — OIDC com Azure](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure)
