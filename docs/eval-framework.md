# Seed Eval Framework — Canonical Reference

The single source of truth for **what seed-create is**, **what the eval does**, and the **shared vocabulary**.
Keep this current; when in doubt about a term or a step, this doc wins.
(Detailed design lives in `docs/superpowers/specs/2026-06-25-seed-eval-framework-design.md`.)

---

## 1. What seed-create is (and is trying to do)

seed-create captures a **working capability** — a tool or app already running on someone's machine — into a
**SEED**: a single, self-contained **prose** spec that another agent can rebuild the whole thing from.

The realistic setup: someone vibe-coded working software; their agent has the **full source** + the running
app. seed-create's job is to **read the source, look at what they built, and extract the ESSENCE** into a seed
— *not* to copy the code.

**Discipline — extract, don't copy:**
- **Prose whenever possible.** Describe what the thing does and how it's built.
- **Inline code *snippets* are fine** when a few lines communicate more clearly than words.
- **No huge code blocks, no verbatim source dumps, no giant reference variables / data literals.**
- *"Ship the seed, not the plant."*

A **good** seed is a concise description that conveys the essence. A **bad** seed is a source-dump that
happens to rebuild. The eval must be able to tell these apart.

---

## 2. The eval flow — four named, isolated components

The evaluator runs four steps. These names are canonical — always use them:

| Step | Name | What it does |
|---|---|---|
| 1 | **Setup** | Build the original, run the oracle on it to confirm it's green (a valid yardstick), capture reference evidence. |
| 2 | **Seed Creator** | Run seed-create on the target (**full `source/` visible**) → produces the **SEED**. |
| 3 | **Seed Installer** | A **separate, blind** agent that installs/builds the software **from the SEED alone** — no source, no tests, no oracle. |
| 4 | **Evaluator** | A **third** agent/step that evaluates the *installed* software against our criteria (the oracle) → a **scorecard**. |

**Flow:** Setup → Seed Creator → Seed Installer → Evaluator.

**Isolation rule:** the **Seed Creator** and the **Seed Installer** are strictly separate agents. The Installer
*only ever sees the SEED* — never the source, tests, or oracle. (Network is on for realism; a post-hoc leakage
audit invalidates any run where the Installer fetched the real target.)

---

## 3. What we evaluate — ONE number, a per-project recipe, a trend signal

**An eval produces ONE number** (the headline), rolled up from a **per-project recipe** of component signals.
All the component numbers are still **shown** in the scorecard as the breakdown — they just also combine into
the single number.

- **Each project declares its own recipe** (in `eval.json`): a project *with* tests makes "the tests passing"
  most of the number; a project *without* (dampe) uses a handful of **general behavioral checks we write**
  (does it run? do playing apps show in the menu? does the slider change the sound?) plus a **"does this
  screenshot match the original?"** check.
- **Component signals** available to a recipe: project tests (`X/N`, where they exist) · **our** behavioral
  criteria · **visual similarity** vs the reference · **code-copy / essence** (how much verbatim code is in the
  seed — a source-dump is a bad seed even if it rebuilds).
- **NO hard pass/fail gates.** "Does it run" is just a heavily-weighted *input*, never an artificial zero.
- **The number is for tracking the TREND** — is seed-create holding steady or improving as we change it, and
  catching *major regressions*. It is **not** a bar you must clear (we don't fail a PR for not hitting 100%).

A **great** seed scores high *and* low on code-copy (real essence extraction). High fidelity *with* lots of
copied code = the skill cheated by copying, not extracting — surfaced in the breakdown.

---

## 4. Inputs & outputs (the standard structure)

Every eval is a folder; everything a run produces is preserved.

```
evals/<target>/
  eval.json          # manifest: name, environment {type: docker|macos-vm, image}, oracle {criteria, reference}, optional tests cmd
  source/            # the full project (code + tests if it has them). The Seed Creator sees this; the Installer never does.
  oracle/            # OUR hidden material — hidden from BOTH Creator and Installer:
    criteria.json    #   our behavioral checks (the things we verify in the output)
    reference/       #   the original's captured evidence (screenshots / video / output) to compare against
  runs/
    index.json       # rollup: every run + its scores + leakage verdict + links
    <run-id>/
      run.json       # run manifest: config snapshot, env+image, timestamps, status, leakage verdict, scores
      seed/          # THE SEED (Seed Creator output)
      rebuild/       # THE INSTALLED SOFTWARE — reconstructed code (src/) + built artifact (build/)
      transcripts/   # capture.jsonl (Seed Creator) + rebuild.jsonl (Seed Installer) — retained for post-hoc review
      egress.log     # network egress during install (leakage-audit input)
      score/
        scorecard.json   # fidelity (our-criteria X/N + project-tests X/M + visual verdict) + code-copy flag + failure attribution
        evidence/        # screenshots, video, raw test output the Evaluator looked at
        leakage-audit.json
      run-summary.md
```

**In → out:** the Seed Creator gets `source/` → produces the **seed** → the Seed Installer gets *only the seed*
→ produces the **installed software** → the Evaluator scores it against the (hidden) `oracle/`.

---

## 5. Glossary

- **SEED** — the single prose spec seed-create produces; the only thing the Seed Installer receives.
- **source/** — the full project (code + tests if any). Seen by the Seed Creator, never the Installer.
- **oracle/** — our hidden evaluation material (criteria + reference). Hidden from *both* Creator and Installer
  — it's the benchmark label set, like answer keys a graded system never sees.
- **scorecard** — the Evaluator's output: fidelity + the code-copy flag + failure attribution.
- **leakage audit** — post-hoc check that the Installer didn't fetch the real target; invalidates the run if it did.
