---
title: "How I Use CLAUDE.md Every Day"
description: "A practical approach to layered context with CLAUDE.md applied to the DevOps world: global, repository, and component scopes — with real examples from Terraform, GitHub Actions, ArgoCD, and AKS."
pubDate: 2026-05-10
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
category: "AI & MLOps"
tags: ["claude", "claude-code", "ai", "devops", "platform-engineering", "terraform", "kubernetes", "github-actions", "azure"]
readingTime: "14 min"
lang: "en"
draft: false
---

> **What you'll find here**
> - How Claude Code discovers and loads `CLAUDE.md` files
> - The three-layer structure I use: global → repository → component
> - Real examples from IaC pipelines, GitHub Actions with OIDC, and AKS modules
> - Honest limitations, alternative strategies, and official documentation links

---

## Table of Contents

- [Context and Motivation](#context-and-motivation)
- [How Claude Code Reads CLAUDE.md Files](#how-claude-code-reads-claudemd-files)
- [My Three-Layer Structure](#my-three-layer-structure)
  - [Layer 1 — Global](#layer-1--global)
  - [Layer 2 — Repository](#layer-2--repository)
  - [Layer 3 — Component / Subdirectory](#layer-3--component--subdirectory)
- [Concrete Example](#concrete-example)
- [Benefits](#benefits)
- [Limitations and Pitfalls](#limitations-and-pitfalls)
- [Other Strategies](#other-strategies)
- [FAQ](#faq)

---

## Context and Motivation

As a Cloud & DevOps engineer, my day is a constant context switch: one moment I'm writing a Terraform module to provision AKS on Azure, the next I'm debugging a GitHub Actions pipeline with OIDC authentication, and shortly after I'm reviewing Kubernetes manifests for an ArgoCD rollout.

When I started using [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) intensively in this environment, I kept repeating the same instructions in every session: Azure resource naming conventions, the team's Terraform module structure, which Kubernetes version we were targeting, the format of environment variables in Azure DevOps pipelines…

The classic problem with any context-window-based tool: **what isn't in the context, the model doesn't know**. And rebuilding that context manually for each session is expensive, slow, and error-prone — especially when you're juggling multiple infrastructure repositories at the same time.

The solution Claude Code itself provides are `CLAUDE.md` files — Markdown documents loaded automatically that define rules, conventions, and expected behaviors. The key is understanding *how* to leverage them in layers so the assistant already knows you're using `azurerm` as your Terraform provider, that your Kubernetes clusters run version 1.31, and that every pipeline needs manual approval before `apply` — without you having to repeat any of that.

---

## How Claude Code Reads CLAUDE.md Files

Before discussing my structure, it's essential to understand the official mechanism.

Claude Code loads `CLAUDE.md` files from **multiple locations, in increasing order of precedence**:

| Location | When it's loaded |
|---|---|
| `~/.claude/CLAUDE.md` | Always — the user's global context |
| `<repo-root>/CLAUDE.md` | When you work on any file in the repository |
| `<subfolder>/CLAUDE.md` | When you work on files *inside* that subfolder |

This means contexts **stack**: the global is the base, the repository adds project-specific details, and subdirectories refine further for a concrete component.

> **Official reference:** [Anthropic Docs — CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory#claudemd-files)

Beyond `CLAUDE.md` files, you can use `@filename` syntax inside any of them to include the content of other files — the equivalent of a context `import`.

```markdown
<!-- Inside CLAUDE.md -->
@.claude/conventions/terraform-style.md
@.claude/conventions/kubernetes-naming.md
@.claude/conventions/pipeline-standards.md
```

This is especially useful for platform repositories where conventions are extensive — you keep each convention in a dedicated file and reference only what's relevant for each component.

> **Official reference:** [Anthropic Docs — @ imports](https://docs.anthropic.com/en/docs/claude-code/memory#importing-files-with-)

---

## My Three-Layer Structure

### Layer 1 — Global

**File:** `~/.claude/CLAUDE.md`

This is the file that applies to *everything* — any project, any repository, any session. Here I only put what is true for 100% of my working contexts:

```markdown
# Global Context — Felipe Rezende

## Identity and language
- I'm Brazilian. Default to Portuguese in prose and documentation, unless
  code conventions, YAML manifests, or tooling require English.
- Shell/bash and HCL comments: English.
- Documentation and commit messages: Portuguese.

## Commit style
- Follow Conventional Commits: feat, fix, docs, chore, refactor…
- Imperative mood, maximum 72 chars in the subject line.
- Examples: `feat(aks): add spot node pool`, `fix(pipeline): fix approval gate`

## IaC general principles
- Prefer reusable modules over repeated inline resources.
- Every managed resource must have mandatory tags: environment, owner, cost-center.
- Validate with `terraform validate` and `tflint` before any PR.
- Never run `terraform apply` without a saved plan (`-out=tfplan`).

## Security
- Never write hardcoded secrets, tokens, or connection strings.
- Secrets go into Azure Key Vault or as Kubernetes Secrets (preferably
  managed by the External Secrets Operator).
- Identify and flag CIS Benchmark violations when relevant.
- In pipelines, prefer OIDC/Workload Identity over long-lived credentials.
```

Notice that here there is **no** mention of which Terraform version to use, which Azure subscription, or which Kubernetes cluster. The global is the common denominator — rules that apply regardless of which repository I'm opening.

---

### Layer 2 — Repository

**File:** `<repo>/.claude/CLAUDE.md`

I prefer placing it inside `.claude/` to avoid cluttering the repository root:

```
platform-infra/
  .claude/
    CLAUDE.md                    ← repository context
    agents/
      iac-reviewer.md            ← reviews Terraform/Bicep against team standards
      pipeline-debugger.md       ← analyzes failures in GitHub Actions / Azure DevOps
      k8s-manifest-writer.md     ← generates manifests following cluster conventions
    commands/
      /plan-summary.md           ← summarizes terraform plan output in English
      /pr-infra.md               ← generates PR descriptions for infrastructure changes
      /argo-sync-check.md        ← checks ArgoCD sync status
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

The repository's `CLAUDE.md` defines everything specific to this platform repository:

```markdown
# Context — Platform Infrastructure Repository

## Stack and versions
- Terraform >= 1.9 with backend on Azure Blob Storage
- Provider azurerm ~> 4.0
- Kubernetes 1.31 (AKS, Stable channel)
- Helm 3.x for platform charts
- ArgoCD 2.13 for application GitOps

## Terraform module structure
- `modules/` → internal reusable modules (no own state)
- `environments/<env>/` → per-environment configurations (tfvars + backend config)
- Each module must have `README.md`, `variables.tf`, `outputs.tf`, and `main.tf`
- Don't create resources outside modules; always encapsulate.

## Azure naming conventions
- Pattern: `<type>-<project>-<environment>-<region>`
- Examples: `aks-platform-prod-eastus2`, `rg-platform-prod-eastus2`
- Region abbreviations: eastus2 → `eus2`, brazilsouth → `brs`

## CI/CD
- GitHub Actions for IaC (Terraform): OIDC with Federated Identity in Azure AD
- Azure DevOps Pipelines for application deployments
- Every `terraform apply` in production requires manual approval via Environment Protection Rules
- Standard workflow: `terraform fmt → validate → tflint → plan → (approval) → apply`

## GitOps with ArgoCD
- Apps declared in `gitops/apps/` as ApplicationSets
- Strategy: automatic sync in dev/staging, manual in prod
- Helm values per environment in `gitops/values/<env>/`

## What NOT to do
- Don't use `count` to create resources with different identities — use `for_each`.
- Don't commit `.tfstate` or `.tfplan` files — they're in `.gitignore`.
- Don't use `latest` as image tag in production manifests.
- Don't expose Azure resources without NSG or Private Endpoint.
```

#### Agents and Commands per repository

Inside `.claude/agents/` and `.claude/commands/`, I define reusable behaviors **scoped to this platform repository**:

```markdown
<!-- .claude/agents/iac-reviewer.md -->
# Agent: IaC Reviewer

You are an experienced infrastructure-as-code reviewer.
When reviewing Terraform or Bicep in this repository:
- Verify that all resources have the mandatory tags (environment, owner, cost-center)
- Flag use of `count` where `for_each` would be more appropriate
- Check that new modules have a README and declared outputs
- Highlight publicly exposed resources without justification
- Validate resource names against the `<type>-<project>-<environment>-<region>` pattern
```

```markdown
<!-- .claude/commands/plan-summary.md -->
# Command: /plan-summary

Receive `terraform plan` output and produce a summary with:
1. How many resources will be created / modified / destroyed
2. High-risk changes (destructions, ID changes, networking modifications)
3. Estimated cost impact (if visible in the plan)
4. Recommendation: safe to apply / requires human review
```

> **Official reference:** [Anthropic Docs — Custom Slash Commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)  
> **Official reference:** [Anthropic Docs — Sub-agents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)

---

### Layer 3 — Component / Subdirectory

This layer is used when a component has enough complexity to deserve its own context. In the DevOps world, this happens frequently:

- The Terraform AKS module has parameters and design decisions that the networking module doesn't
- The GitHub Actions pipeline folder follows different conventions from the Azure DevOps Pipelines folder
- Kubernetes manifests for a critical application have specific security constraints

**Example: Terraform AKS module**

**File:** `modules/aks/CLAUDE.md`

```markdown
# Terraform Module — AKS

## Purpose
Provisions AKS clusters with standardized production configurations:
private cluster, Azure CNI Overlay, Workload Identity enabled.

## Required variables
- `cluster_name`: follows the repository naming convention
- `kubernetes_version`: must be on the Stable channel (currently 1.31)
- `node_pools`: map of objects — don't use a list, use map for for_each
- `log_analytics_workspace_id`: required, no exceptions

## Design decisions
- Always enable `oidc_issuer_enabled` and `workload_identity_enabled`
- System node pool: Standard_D4ds_v5 minimum (4 vCPU, 16 GB)
- User node pool: configurable, but define `taints` to isolate workloads
- Don't use cluster-level managed identity — use pod-level with Workload Identity

## Expected outputs
Always export: `cluster_id`, `kube_config`, `oidc_issuer_url`,
`kubelet_identity_object_id`

## Tests
- Module tests in `tests/aks/` using Terratest (Go)
- Run locally with: `cd tests/aks && go test -v -timeout 60m`
```

**Example: GitHub Actions pipelines**

**File:** `pipelines/.github/workflows/CLAUDE.md`

```markdown
# Context — GitHub Actions Workflows

## Standards for this repository
- Every workflow starts with `on: pull_request` + `on: push: branches: [main]`
- Use `permissions: id-token: write` for OIDC — never store CLIENT_SECRET
- Azure login steps: always `azure/login@v2` with `client-id`, `tenant-id`,
  `subscription-id` via vars (not secrets for public IDs)
- Production environments use `environment: production` with required reviewers

## Secrets and variables
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: GitHub Vars (not secrets)
- `TF_STATE_RESOURCE_GROUP`, `TF_STATE_STORAGE_ACCOUNT`: GitHub Vars
- No passwords or tokens should appear in inline `env:` — use `secrets.*`

## Job structure
```yaml
jobs:
  validate:
    # fmt, validate, tflint
  plan:
    needs: validate
    # terraform plan -out=tfplan
  apply:
    needs: plan
    environment: production  # approval gate
    # terraform apply tfplan
```

## Reusable Workflows
- Reusable workflows live in `.github/workflows/reusable/`
- Call with `uses: ./.github/workflows/reusable/terraform-plan.yml`
```

---

## Concrete Example

Real scenario: I'm editing `modules/aks/main.tf` to add spot node pool support.

Claude Code loads, in this order:

1. `~/.claude/CLAUDE.md` → language, commits, IaC principles, security
2. `platform-infra/.claude/CLAUDE.md` → versions (Terraform 1.9, azurerm 4.x, K8s 1.31), Azure naming conventions, CI/CD workflow
3. `platform-infra/modules/aks/CLAUDE.md` → required variables, module design decisions, expected outputs

When I ask:

> "Add spot node pool support to the AKS module. Use preemptible with on-demand fallback."

The model already knows:
- To use `for_each` on the `node_pools` map (not `count`)
- That `kubernetes_version` must be `1.31`
- That node pools need `taints` to isolate workloads
- That the outputs `cluster_id` and `oidc_issuer_url` must be preserved
- That the result needs to pass `terraform validate` and `tflint`
- To write code comments in English and respond in Portuguese

All of that without a single extra instruction in my prompt.

---

## Benefits

### Consistency Across Sessions and Repositories

All infrastructure repositories respect the same mandatory tags, the same Azure naming pattern, and the same pipeline rules — because that's in the repository's CLAUDE.md, not relying on my memory.

### Platform Onboarding for New Projects

When a new infrastructure repository is created, we copy the `.claude/` template with base conventions. The assistant already knows the team's rules from the very first commit.

### Specialized Agents per Context

An `iac-reviewer` agent in a Terraform repository knows how to verify tags, modules, and outputs. A `pipeline-debugger` agent in a workflows repository knows how to analyze GitHub Actions and Azure DevOps logs. Each one focused on its domain.

### GitOps for the Context Itself

`.claude/` files evolve together with the repository via pull requests. When a naming convention changes, the refactoring PR includes the `CLAUDE.md` update. The context history is in Git.

### Guardrail for Critical Operations

When the assistant already knows that `terraform apply` in production requires a saved plan and manual approval, it won't suggest shortcuts. The context is an additional guardrail layer.

---

## Limitations and Pitfalls

### Token Budget

Platform repositories tend to have extensive conventions. If the repository's `CLAUDE.md` plus the module's plus the global one sum to many tokens, you'll consume a large portion of the context window before any actual conversation.

**Recommended practice:** use `@imports` to separate conventions into smaller files and load them on demand. The main `CLAUDE.md` points to the relevant files:

```markdown
# Context — platform-infra

@.claude/conventions/terraform-style.md
@.claude/conventions/azure-naming.md

<!-- Load only if relevant for the current component: -->
<!-- @.claude/conventions/kubernetes-manifests.md -->
```

### Stale Content

Updated the `azurerm` provider from `3.x` to `4.x`? The `CLAUDE.md` that said `~> 3.0` will keep generating old-version code until it's updated. In IaC, this can cause silent diffs.

**Recommended practice:** add an `# Updated: YYYY-MM-DD` line at the top and include `CLAUDE.md` review as a mandatory item in provider upgrade or Kubernetes version PRs.

### Not a Conversation Memory Replacement

`CLAUDE.md` doesn't know you spent the last hour debugging an Azure vCPU quota error. It defines *structural rules*, not the state of your current session.

**Recommended practice:** for long troubleshooting sessions, keep a temporary state file and reference it with `@` at the start of the session.

### Layer Conflicts

The global says "validate with tflint" but a specific module has a custom tflint configuration. Deeper layers generally take precedence, but this isn't explicitly guaranteed.

**Recommended practice:** at the component level, be explicit about what overrides. If the AKS module uses a different tflint config, declare that clearly in its `CLAUDE.md`.

### Sensitive Information

Never put subscription IDs, tenant IDs, internal IPs, production resource names, or any sensitive operational data in `CLAUDE.md` files. Use placeholders like `<subscription-id>` and `<cluster-name>`.

---

## Other Strategies

### System Prompts via API

If you use the Anthropic API directly for automation (IaC review scripts, pipeline bots, etc.), the equivalent is the `system prompt`. You can inject context dynamically — for example, piping `terraform plan` output into the system prompt of an automated review script.

> Reference: [Anthropic Docs — System Prompts](https://docs.anthropic.com/en/docs/build-with-claude/system-prompts)

### Projects (Claude.ai)

On the Claude.ai web interface, the [Projects](https://support.anthropic.com/en/articles/9517075-what-are-projects) feature lets you create a space with custom instructions and persistent knowledge documents. Useful for architecture discussions that don't involve direct code editing.

**When to prefer Projects:** architecture reviews, ADR (Architecture Decision Record) discussions, when you're in an analysis context rather than a code editing one.

### Cursor Rules (`.cursorrules`)

[Cursor](https://www.cursor.com/en/features) uses a `.cursorrules` file with a similar purpose. The difference is that Cursor applies this context transparently, while Claude Code gives you explicit visibility into what's being loaded — important when you want to audit what the assistant "knows."

### Copilot Instructions (`.github/copilot-instructions.md`)

[GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot) supports repository instructions at `.github/copilot-instructions.md`. One advantage: it's already in the `.github/` folder, which platform repositories typically have anyway.

### Quick Comparison

| Strategy | Scope | Version Control | Hierarchy | Cost |
|---|---|---|---|---|
| `CLAUDE.md` (Claude Code) | Global + repo + subfolders | ✅ | ✅ 3 layers | Claude Max / API |
| Projects (Claude.ai) | Per web project | ❌ (cloud) | ❌ 1 layer | Claude Pro/Team |
| `.cursorrules` | Per repository | ✅ | ❌ 1 layer | Cursor |
| `copilot-instructions.md` | Per repository | ✅ | ❌ 1 layer | GitHub Copilot |

---

## FAQ

**Q: Do I need a `CLAUDE.md` in *every* Terraform module in my repository?**  
A: No. Only add one where the context genuinely diverges. Simple modules (e.g., a resource group, a storage account) are typically covered by repository-level conventions. Reserve the component `CLAUDE.md` for complex modules with non-obvious design decisions, like AKS, hub-spoke networking, or identity modules.

---

**Q: Does `CLAUDE.md` work in editors other than VS Code?**  
A: Yes. Claude Code loads `CLAUDE.md` regardless of the editor — it works in the terminal, VS Code, JetBrains, and any environment where the `claude` CLI is installed.

---

**Q: Can I use the same `.claude/` template across multiple infrastructure repositories?**  
A: Not natively via symlinks. The most practical approach is to maintain a `platform-templates` repository with a base `.claude/` directory, copied when creating new repositories. Use `@imports` to reference shared conventions from another path if teams need continuous sync.

---

**Q: Is it safe to commit `.claude/` in infrastructure repositories?**  
A: Yes, as long as you follow the rule: *never put subscription IDs, tenant IDs, internal IPs, production resource names, or credentials*. Use placeholders like `<subscription-id>`. What should go into `.claude/`: naming patterns, provider/tool versions, design decisions, pipeline conventions.

---

**Q: How does CLAUDE.md integrate with existing IaC review workflows?**  
A: `CLAUDE.md` doesn't replace tools like `tflint`, `checkov`, or `terrascan`. It complements them: while automated tools enforce static rules, the CLAUDE.md context lets the assistant understand *why* certain decisions were made and suggest changes that are consistent with the repository's architecture.

---

**Q: Is there a size limit for CLAUDE.md?**  
A: There's no explicitly documented hard limit, but the content goes into the model's context window. Platform repositories with extensive conventions should use `@imports` to split into smaller files, loading only what's needed per component.

---

## References

- [Claude Code — Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Claude Code — Memory and CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Claude Code — Slash Commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- [Claude Code — Sub-agents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Claude.ai — Projects](https://support.anthropic.com/en/articles/9517075-what-are-projects)
- [Anthropic — System Prompts](https://docs.anthropic.com/en/docs/build-with-claude/system-prompts)
- [GitHub Copilot — Repository Instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [Terraform — Modules](https://developer.hashicorp.com/terraform/language/modules)
- [Azure Kubernetes Service — Documentation](https://learn.microsoft.com/en-us/azure/aks/)
- [ArgoCD — Documentation](https://argo-cd.readthedocs.io/en/stable/)
- [GitHub Actions — OIDC with Azure](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure)
