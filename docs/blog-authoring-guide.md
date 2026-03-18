# Blog Authoring Guide

A step-by-step reference for creating and managing blog posts on **rezendesfelipe.github.io**.

---

## Table of Contents

- [File location & naming](#1-file-location--naming)
- [Frontmatter fields explained](#2-frontmatter-fields-explained)
- [Article formats](#3-article-formats)
  - [Default (Blueprint / Deep-dive)](#31-default-blueprint--deep-dive)
  - [Tutorial](#32-tutorial)
  - [Case Study](#33-case-study)
- [Writing the body](#4-writing-the-body)
- [Adding a hero image](#5-adding-a-hero-image)
- [Changing / adding categories](#6-changing--adding-categories)
- [Publishing checklist](#7-publishing-checklist)
- [How drafts work](#8-how-drafts-work)
- [Preview & deploy](#9-preview--deploy)

---

## 1. File location & naming

All blog posts live in:

```
src/content/blog/
```

- Use **kebab-case** for file names: `my-post-title.md` or `my-post-title.mdx`
- Use `.md` for plain Markdown, `.mdx` when you need JSX components (e.g., interactive code tabs, custom callout boxes)
- The file name becomes the URL slug: `my-post-title.md` → `/blog/my-post-title/`

---

## 2. Frontmatter fields explained

Every post starts with a YAML frontmatter block between `---` delimiters.

```yaml
---
title: "Your Post Title"           # Required – shown in cards, browser tab, SEO
description: "One-sentence TL;DR" # Required – shown in cards and meta tags
pubDate: 2026-03-18                # Required – publication date (YYYY-MM-DD)
updatedDate: 2026-03-18            # Optional – if you update the post later

author:                            # Optional – enables author bio (E-E-A-T)
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"

category: "Cloud & DevOps"        # Optional – used for category tabs on /blog/
tags: ["cloud", "devops", "kubernetes"]  # Optional – shown as tag chips
readingTime: "8 min"               # Optional – estimated reading time

lang: "pt"                         # "pt" (default) or "en" (goes to /en/blog/)
draft: false                       # true = hidden from listing, false = published

# heroImage: ../../assets/my-image.jpg   # Optional – image shown at top of card/post
# canonical: "https://yourdomain.com/blog/my-post"  # Optional – canonical URL
---
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | Keep under ~80 chars for SEO |
| `description` | ✅ | 120–160 chars for best meta snippet |
| `pubDate` | ✅ | ISO date `YYYY-MM-DD` |
| `updatedDate` | – | Show only when content changed significantly |
| `author.name` | – | Shown in author bio strip; defaults to "Felipe Rezende" |
| `author.role` | – | Shown beneath the name |
| `author.url` | – | Makes the name a clickable LinkedIn / GitHub link |
| `category` | – | Must match one of the 8 top categories (see §6) |
| `tags` | – | Lowercase, hyphenated; as many as relevant |
| `readingTime` | – | e.g. `"12 min"` – no auto-calculation |
| `lang` | – | `"pt"` (default) or `"en"` |
| `draft` | – | Defaults to `false`; set `true` to hide while writing |
| `heroImage` | – | Relative path to an image in `src/assets/` |
| `canonical` | – | Only needed for cross-posts |

---

## 3. Article formats

### 3.1 Default (Blueprint / Deep-dive)

Use for comprehensive technical articles, architecture blueprints, and reference guides.

```markdown
---
title: "Blueprint: Deploying a Production-Ready AKS Cluster"
description: "A step-by-step Cloud & DevOps guide: architecture, IaC, CI/CD, security."
pubDate: 2026-03-18
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
tags: ["cloud", "devops", "kubernetes", "terraform", "aks"]
category: "Cloud & DevOps"
readingTime: "12 min"
draft: false
---

> **In this guide you'll learn**
> - A reference AKS architecture (hub/spoke, private cluster, managed identities).
> - Reusable Terraform modules with environment matrix.
> - GitHub Actions pipeline with OIDC, policy checks, and drift detection.

---

## Table of Contents
- [Context & Problem Statement](#context--problem-statement)
- [Architecture Overview](#architecture-overview)
- [FAQ](#faq)

---

## Context & Problem Statement
...

## Architecture Overview
...

## FAQ

**Q: Can I use this with Azure DevOps instead of GitHub Actions?**  
A: Yes — replace the OIDC step with a service connection…
```

### 3.2 Tutorial

Use for hands-on, step-by-step labs. The JSON-LD schema automatically switches to `HowTo` when `category: "Tutorials"`.

```markdown
---
title: "Tutorial: GitHub Actions OIDC + Terraform to Provision AKS"
description: "Hands-on guide to set up OIDC, create a Terraform workflow, and provision AKS."
pubDate: 2026-03-18
author:
  name: "Felipe Rezende"
  role: "Cloud & DevOps Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
tags: ["tutorial", "terraform", "github-actions", "aks", "azure"]
category: "Tutorials"
readingTime: "18 min"
draft: false
---

> **What you'll build**
> - GitHub Actions OIDC trust to Azure (no stored secrets)
> - Terraform project with network + AKS + ACR modules

---

## Prerequisites
- Azure account with **Contributor** permissions
- Terraform ≥ 1.6
- GitHub repo with Actions enabled

> **Estimated time:** 60–90 min · **Level:** Intermediate

---

## Step 1 — Configure OIDC
...

## Step 2 — Write Terraform modules
...

## FAQ

**Q: What if my organization blocks OIDC?**  
A: Fall back to a service principal stored in GitHub Secrets…
```

### 3.3 Case Study

Use for before/after stories, customer outcomes, and retrospectives.

```markdown
---
title: "Case Study: From Snowflake Deploys to 30-Minute Releases"
description: "How a platform team cut lead time by 82% using IaC, OIDC and policy guardrails."
pubDate: 2026-03-18
author:
  name: "Felipe Rezende"
  role: "Principal Cloud Architect"
  url: "https://www.linkedin.com/in/rezendesfelipe/"
tags: ["case-study", "platform-engineering", "devops", "aks", "finops"]
category: "Customer Stories"
readingTime: "10 min"
draft: false
---

> **Snapshot**
> - **82%** lead-time reduction · **0** long-lived secrets · **~35%** infra cost drop

---

## Company & Context
...

## Objectives & KPIs
- Lead time, Change failure rate, MTTR, Infra cost / month, SLOs

## Before → After (Architecture)
**Before:** Manual deploys, static credentials, configuration drift
**After:** Terraform modules, OIDC, private AKS, ACR, policies

## Key Results
| Metric | Before | After |
|---|---|---|
| Lead time | ~4 hours | 30 min |
| Secrets exposed | 12 | 0 |
| Infra cost / month | $4,200 | $2,700 |
```

---

## 4. Writing the body

### Structural H2/H3 cadence

```
H2 → major section (e.g., "Architecture Overview")
  H3 → sub-topic (e.g., "Hub-and-Spoke Networking")
    H4 → fine detail (use sparingly)
```

### Table of Contents

The TOC sidebar is **built automatically** from your H2/H3 headings in JavaScript — you don't need to hand-write it. However, adding a manual TOC list at the top of the post (as a Markdown list) improves scannability for readers who disable JS.

### Callouts / Executive Summary

Use Markdown blockquotes at the very top:

```markdown
> **In this guide you'll learn**
> - Point A
> - Point B
```

### Code blocks

````markdown
```bash
az aks create --name my-cluster --resource-group my-rg
```
````

Specify the language after the opening fences for syntax highlighting.

### Mermaid diagrams

Use fenced `mermaid` blocks — Astro will render them if you add the `@astrojs/mermaid` integration, or you can use an image instead.

---

## 5. Adding a hero image

1. Place your image in `src/assets/` (e.g., `src/assets/blog/aks-hero.jpg`)
2. Reference it in frontmatter with a relative path:

```yaml
heroImage: ../../assets/blog/aks-hero.jpg
```

- Recommended size: **1020 × 510 px** (2:1 ratio)
- Astro optimizes and converts it to WebP automatically
- If no `heroImage` is set, the card shows a gradient placeholder with a 📄 emoji

---

## 6. Changing / adding categories

Categories are defined in **two places**. Update both to add or rename a category.

### Place 1 — `src/pages/blog/index.astro` (Portuguese blog)

```typescript
const TOP_CATEGORIES = [
  'Cloud & DevOps',
  'Tutorials',
  'Customer Stories',
  'Security',
  'Platform Engineering',
  'SRE & Observability',
  'FinOps',
  'AI & MLOps',
];
```

### Place 2 — `src/pages/en/blog/index.astro` (English blog)

Same `TOP_CATEGORIES` array — keep them in sync.

**To add a category:** append a new string to both arrays.  
**To rename:** change the string in both arrays **and** update `category:` in every post that used the old name.  
**To remove:** delete from the array — posts using that category still render, but the tab disappears.

> The category tabs are purely a UI filter. They don't affect routing or the schema.

---

## 7. Publishing checklist

Before merging a post to `main`:

- [ ] `draft: false` (or field removed — defaults to `false`)
- [ ] `pubDate` set to today's date
- [ ] `title` and `description` filled in and spell-checked
- [ ] `author` block filled with your real name and LinkedIn URL
- [ ] `category` matches one of the 8 top categories exactly (case-sensitive)
- [ ] `tags` are lowercase and hyphenated
- [ ] `readingTime` estimated (count ~200 words/min)
- [ ] Hero image added (or intentionally omitted for gradient placeholder)
- [ ] H2/H3 headings used (TOC auto-builds from them)
- [ ] FAQ section at the bottom (improves SEO for "How To" queries)

---

## 8. How drafts work

Set `draft: true` in frontmatter to hide a post from all listings and feeds while you're writing:

```yaml
draft: true
```

The post file can live in `src/content/blog/` — it won't appear on `/blog/`, RSS feed, or search results. When ready, change to `draft: false` and push.

---

## 9. Preview & deploy

### Local preview

```bash
# Install dependencies (first time only)
npm install

# Start dev server with hot reload
npm run dev
# → Open http://localhost:4321/blog/
```

### Production build check

```bash
npm run build   # TypeScript + Astro compile
npm run preview # Serve the /dist/ build locally
```

### Deploy

Push to the `main` branch — the `deploy.yml` GitHub Actions workflow builds and publishes to GitHub Pages automatically. No manual steps needed.

---

*Last updated: 2026-03-18*
