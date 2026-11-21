---
lang: "en"
page: "digicode"
title: "Digicode"
subtitle: "Technology in service of breastfeeding protection"
description: "How I helped make auditable and secure a platform that documents non-compliant digital marketing of breast-milk substitutes."
pubDate: 2026-11-21
tags: ["Python", "FastAPI", "AI governance", "Supply chain security", "Public health"]
featured: true
order: 1
logo:
  src: "/images/projects/digicode/fiocruz-logo.svg"
  alt: "Fiocruz – Oswaldo Cruz Foundation, Brazilian Ministry of Health"
  href: "https://portal.fiocruz.br/"
meta:
  - label: "Role"
    value: "Independent consultant: architecture, code quality, applied AI and infrastructure"
  - label: "Project lead"
    value: "Cristiano Boccolini, researcher at Fiocruz"
  - label: "Period"
    value: "July to November 2026"
  - label: "Stack"
    value: "Python 3.12, FastAPI, pytest, ruff, mypy, GitHub Actions, Tesseract OCR, Ollama"
  - label: "Deliverables"
    value: "31 merged PRs, 25 of the project's 26 ADRs, 1 architecture and governance report, 1 infrastructure design"
highlights:
  - value: "31"
    label: "merged PRs"
  - value: "42"
    label: "dependency vulnerabilities closed"
  - value: "1 → 4"
    label: "collection surfaces with honest governance"
  - value: "−43%"
    label: "in the largest module (3,849 → 2,211 lines)"
---

## The problem

Formula marketing is a well-documented driver of declining breastfeeding. That is why the WHO International Code of Marketing of Breast-milk Substitutes (1981) and, in Brazil, the NBCAL law (Law 11,265/2006) restrict how infant formula, growing-up milks, feeding bottles and teats may be advertised.

Enforcement was designed for TV, packaging and the point of sale. Today the advertising lives in paid ads on Google and Meta, YouTube videos and online retail pages. The volume is large, the content disappears once the campaign ends, and every platform exposes its data differently. In 2022, WHO and UNICEF documented how digital formula marketing has become systematic and hard to track.

## What Digicode is

Digicode is a **public-health evidence infrastructure**. It collects public ads from the platforms' transparency libraries (Google Ads Transparency Center, Meta Ad Library, YouTube) and from online retail, preserves every item with provenance and a hash, extracts text through OCR, and runs the material through an auditable classification chain. The output is a set of cases organized for human review by health authorities, civil society and researchers. A separate track applies the same process to ultra-processed foods.

The project's methodological manifesto is explicit about what the system is **not**: it is not an automatic violation detector. Whether a violation occurred is for the competent authority to decide. The system's job is to make sure that decision rests on sound evidence. Four principles shape the design:

- **Evidence before judgment.** First record what is visible, where it was found and how it was captured. Interpretation comes later.
- **No silent failures.** Every record ends with an auditable state and reason. "Out of scope" is not deletion, and missing OCR is never treated as absence of regulated content.
- **When in doubt, hold.** Ambiguous cases go to `safe_hold`. The system never resolves them on its own as "not a violation".
- **Pattern, not just incident.** A single ad can be defended as an exception. A sustained exposure strategy across several surfaces is much harder to explain away.

The architecture is multi-country: the evidence layer and the international references are shared, and national rules stay isolated per country.

## My role

I joined the project to review the code and propose improvements. The work grew into architecture, security, classifier governance and infrastructure. Every change followed the same cycle:

1. **Investigate before proposing.** Read the current code, measure, and confirm the problem on today's `main`.
2. **Plan in writing.** A change proposal (OpenSpec) and an ADR with the context, the options considered and the decision.
3. **Get the lead's approval.** No architectural decision went in without explicit sign-off.
4. **Implement with proof.** Tests for every new behavior, every CI gate green, and an AST comparison for every refactor.
5. **Record what went wrong.** The final report has a section on my own estimation mistakes.

I used LLMs heavily and openly: code review with several specialist agents in parallel, adversarial verification of the findings, and independent consultations with AI, DevOps and architecture profiles before the infrastructure design. Technical accountability for every decision stayed with me.

---

## Technical deliverables

The work was organized into four tracks, prioritized by risk.

### Track 1: the system reported all-clear without measuring anything

**Finding.** The pilot Google connector was the only path authorized to run against live data. On every run it wrote four governance records (`ExecutionRun`, `ReplayInput`, `ReplayResult`, `DriftReport`) that feed the project's promotion gates: false-positive, false-negative, coverage-drop and rule-mismatch budgets. The values were hardcoded, always `match`, deltas of `0.0` and `within_budget`. The gates were green by construction, not by evaluation. Four independent specialist reviews reached this finding, the most severe in the assessment, and an adversarial verification pass confirmed it.

**Decision (ADR-0002).** When no baseline comparison was run, the run now reports `not_evaluable`. An explicit promotion blocker keeps "not evaluated" from being read as "approved".

**Why it matters.** In compliance, a false all-clear is worse than no indicator at all. It gives managers and reviewers a confidence the system had no way to back up.

### Track 2: supply-chain and control-plane security

- **42 dependency vulnerabilities closed** (11 in the production lock and 31 in the development lock; `starlette`, the API's HTTP layer, carried 7 on its own). I compared two strategies before choosing. A blanket upgrade moved 34 of 56 packages. A surgical upgrade moved **5**, reached zero advisories and left the CI gate tools untouched. I went with the surgical one. *(ADR-0003)*
- **Vulnerability gate in CI** with `pip-audit`, plus Dependabot to report between builds. *(ADR-0003)*
- **Lock agreement.** A `pytest` bump to fix a CVE had no effect at all on CI, because CI installs only from the lock and the lock still pinned the old version. I built a check that fails the build when a locked version violates a declared constraint. I chose comparison over regeneration, and the ADR records why and the limit: a lock that is merely stale is not detected. *(ADR-0006)*
- **"Unconfigured" now means "closed".** The API's write endpoints (review dispositions, exports, challenges) accepted anonymous writes and recorded the reviewer's identity from the request body, which the caller controls. Authentication is now required by default. *(ADR-0004)*
- **`main` branch protection.** I fixed a `CODEOWNERS` file that didn't work and wrote an automated verifier for the repository's protection settings. *(ADR-0005)*

### Track 3: classifier governance across every surface

While I was implementing Track 1, the project lead asked: *"why was this fix applied only to Google and not to Meta?"* The question revealed that the July assessment had run on a branch five days stale, from before collection went live on four surfaces. I recalibrated the roadmap with data from the live-authorization matrix: **Meta accounted for 79% of authorized volume, Google for 13%, retail for 4% and YouTube for 3%.** The three surfaces writing no governance records at all added up to 87% of the volume.

- **Platform-generic setup contract.** The shared authorization record rejected, by construction, any surface other than Google. *(ADR-0009)*
- **Honest attestation for Meta, retail and YouTube**, each under the same contract as Google, plus a catalog and per-record classification. *(ADR-0010 to ADR-0016)*
- **Audit trail for human reviews.** The documentation claimed the hash-chained ledger of reviewer decisions was verified by the platform's integrity routine, but it wasn't. I closed that gap. The reviewer's decision is the system's final control, and it only counts as evidence if you can prove who decided, when, and that nothing was changed afterwards. *(ADR-0008)*
- **False-negative ledger.** Measuring real drift requires human-adjudicated ground truth on both sides. The false-positive side already had one; the false-negative side had none. *(ADR-0017)*
- **Self-consistency replay harness.** It re-classifies already-captured records and compares the result with the original classification, producing the first real before-and-after pair for the `DriftReport`. *(ADR-0018)*

### Track 4: shrinking the largest file without changing behavior

`collection_executor.py` had **3,849 lines and about 90 functions**, mixing subprocess execution, a watchdog, checkpoints, a circuit breaker, a ledger, retail classification and report generation.

I applied the **strangler fig** pattern: one module extracted at a time, with the existing test suite as the safety net. There were seven extractions (`pipeline_utils`, `retail_classification`, `summary_reports`, `bindings`, `checkpoints`, `circuit_breaker`, `ledger`), each with a plan, an ADR and an **abstract syntax tree (AST) comparison** of every moved function against `main`, to prove the logic was identical. I also split `who/_helpers.py` (1,694 lines, 12 WHO signal detectors) into one module per detector. *(ADR-0019 to ADR-0026)*

**Result:** from 3,849 down to **2,211 lines (−43%)**, with `main` green on every merge.

When `main` changed functions I had already moved, I **ported the new versions** into the extracted modules instead of discarding them, and confirmed again by AST. A WHO normative fix made in parallel was preserved: 29 of 30 symbols were identical, and the thirtieth differed only in its import path.

### Performance: faster OCR, measured the right way

OCR accounts for about **86% of the cost** of the Google pipeline, against 14% for image encoding. The cascade prepared five variants of every image even when the first one was enough. I switched to generating variants on demand (lazy preparation).

The first measurement was misleading: I ran the two versions in different sessions, and the drift between sessions (~390 ms) was larger than the effect being measured. I redid it with an **interleaved A/B** in the same session:

| Scenario | Before | After | Difference |
|---|---|---|---|
| Early exit, 1 OCR call | 4,049.6 ms | 3,600.1 ms | **−449 ms (−11.1%)** |
| Full cascade, 8 calls | 1,524.3 ms | 1,521.6 ms | −2.6 ms (neutral) |

I also tested swapping PNG for uncompressed formats. They would have made every variant **183 ms slower**, so PNG stayed. *(ADR-0007)*

### Infrastructure: a physical server with a local LLM

I designed the infrastructure to run the application, the test gate and a **local LLM with Ollama** on a physical server, with Dev/Staging/Prod environments, network and VPN, and secrets kept out of the repository. The key choices:

- **No multi-node orchestrator in this phase** (k3s/Swarm): the complexity isn't justified on a single server.
- **Survey the hardware before sizing.** GPU and VRAM decide whether Ollama runs on GPU or CPU, and without AVX2, CPU throughput drops by 2 to 3 times.
- **Ollama and Tesseract competing for the same CPU** treated as a real risk, since OCR is 86% of the cost.
- **Local processing**, so that evidence and sensitive data never need to leave for an external LLM API.

---

## Results

| Metric | Value |
|---|---|
| Merged PRs with my work | 31 |
| ADRs authored | 25 of 26 |
| Dependency vulnerabilities closed | 42 (11 in production) |
| Collection surfaces with honest governance | from 1 to 4 (from 13% to virtually 100% of authorized volume) |
| Size of the largest module | 3,849 → 2,211 lines (−43%) |
| OCR latency on the most common case | −11.1% |
| Project state on 2026-11-03 (team effort) | 5,757 passing tests, 85.1% coverage (minimum gate: 70%) |

## What I learned

- **An assessment is only as good as the base it runs on.** Five days of drift skewed the entire prioritization. I now check the `merge-base` before any evaluation.
- **Refactoring estimates miss when the code keeps moving.** I forecast about 2,500 lines after the fourth extraction and landed at 2,996 at that point, because `main` gained new code in the same file. I recorded the miss in the report instead of hiding it.
- **Measuring badly is worse than not measuring.** The first OCR measurement would have endorsed the wrong conclusion.
- **Dependency security is recurring, not one-off.** New advisories blocked CI on every PR in September and again in October. Dependency updates became step zero of every merge queue.

## References

- WHO. [International Code of Marketing of Breast-milk Substitutes](https://www.who.int/publications/i/item/9241541601) (1981)
- Brazil. [Law No. 11,265/2006 (NBCAL)](https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2006/lei/l11265.htm)
- WHO/UNICEF. [How the marketing of formula milk influences our decisions on infant feeding](https://www.who.int/publications/i/item/9789240044609) (2022)
- Martin Fowler. [Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html)
- Michael Nygard. [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- OpenSSF. [SLSA: Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- PyPA. [pip-audit](https://github.com/pypa/pip-audit)
- [Ollama](https://ollama.com/)
