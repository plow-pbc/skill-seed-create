# seed-create Eval Harness — Design (v1)

**Date:** 2026-06-23
**Status:** revised after dual cross-backend spec review; ready for head-chef review
**Author:** sous (kitchen: skill-seed-create)

## Motivation

`skill-seed-create` ships **zero** tests or evals (verified: the repo is 7 content files;
the only checks are agent-driven per-hydration `## Verify` sections + the prose harden loop,
neither of which asserts the creator's own quality). So today there is **no objective way to
tell whether a change to seed-create makes it better or worse** — including any future
Greenfield-inspired techniques.

This harness is the project's **first measurement instrument**: run seed-create on real
software, rebuild that software from the resulting seed in a clean room, and score the
rebuild against the original's own test suite. It produces an objective **fidelity** number
and a classified list of behaviors the seed failed to capture.

## The eval loop (v1)

1. **Baseline** — stand the target up in a container, run its suite, confirm it's green
   (ground-truth for the oracle).
2. **Capture** — run seed-create against the target (with the oracle withheld), **stopping at
   the DRAFT gate** → a seed (a SEED repo, see §Artifacts).
3. **Blind rebuild** — in a separate network-isolated clean container holding *only the seed*,
   an agent hydrates it and builds the target from scratch.
4. **Score** — run the original's pinned oracle bundle against the rebuilt artifact →
   **fidelity = % passing, by failure class**.

(Stage 5, the harden iteration loop, is deferred — see Scope.)

## Methodology — the validity core

The original test suite is a **held-out oracle**, like a test set in ML. It must never inform
the seed. Two refinements came out of review and are load-bearing:

**(A) The real invariant (corrected):** *No stage that informs the seed may touch the oracle.*
The **Baseline cook and the Scorer both run the oracle** — that's fine, because neither feeds
the seed. The stages that DO feed the seed (capture) or stand in for it (rebuild) must be blind.

**(B) Blindness must be enforced against the network, not just the filesystem.** This is the
dominant finding from both reviewers. `oh-my-logo` is a *public GitHub repo and a published npm
package*, so stripping the workspace is necessary but **not sufficient**:
- the **capture cook** could `git clone`/`npm pack` the target and recover the stripped oracle;
- the **rebuild cook** could `npm install oh-my-logo` and re-export it, scoring ~100% fraudulently.

Therefore:
- **Capture container (C):** network **off**. It only needs the stripped repo + the interview.
- **Rebuild container (R):** network-isolated **except a dependency allowlist** — a pre-seeded
  cache or filtering registry proxy that provides the target's *dependencies* but **neither the
  target package nor its repo**. (Rebuild legitimately needs its deps; it must not be able to
  obtain the target itself.)
- Blindness evidence is **positive**: per-run egress/allowlist logs + blocked-host proof, not
  just a filesystem manifest.

**The oracle is more than a test directory.** Node/TS co-locates `*.test.ts`/`*.spec.ts` beside
source and relies on fixtures, snapshots, golden files, a runner config, devDeps, and a test
command. The **oracle bundle** (defined in Chunk 1 as an explicit manifest) is the single source
of truth for BOTH what is withheld at capture AND what the scorer runs — they are complements of
one inventory. Withholding is **glob/file-based**, never "strip the test dir."

**Expected-low-fidelity note:** the oracle is coupled to the original's public API (import paths,
names). A blind rebuild that names things differently fails to import → low fidelity even with
correct behavior. That is intended strict signal — but it's why fidelity is **classified** (below)
so we can tell "wrong API surface" from "wrong behavior" from "harness mismatch."

**Who answers the interview:** a single **author-creator cook** — one cook that has studied the
target (README, usage, source, **oracle withheld**), then runs the seed-create procedure and
answers its own interview. It runs in container C (network off), is autonomous, and is test-blind.
For reproducibility the cook is given a concrete **interview input contract** (the persona's
answers for `CAPABILITY`, `STATE_TO_WIPE`, `HUMAN_STEPS`, publish choice) and is instructed to
**stop at `SEEDCREATE_RESULT=DRAFT`** — NOT to run seed-create's own (mandatory) harden loop,
which would otherwise blow the single-rebuild scope. The full interview transcript + tool logs
are saved each run.

## Artifacts — what "the seed" actually is

`seed-create` produces a **SEED repo** (a directory: `SEED.md` + `README.md`, possibly shell
scripts), git-init'd — *not* a single `<name>.seed.md` file. Container R receives **the whole
seed repo** and nothing else. Note: if the seed repo carries runnable scripts, those are another
path to fetch the target — so the R dependency-allowlist (above) applies regardless of seed
contents.

## Architecture

### Directory layout (new `eval/` dir in this repo)
```
eval/
  harness/                 # codified mechanical scripts (provision, baseline, strip, score, run)
  targets/
    oh-my-logo/
      config.json          # repo URL, pinned SHA, base image, build cmd, test cmd,
                           # oracle manifest (globs: tests+fixtures+snapshots+config), devDeps
  runs/
    run-<id>/              # the ONLY output location. Holds: the seed repo, container logs,
                           # interview transcript + tool logs, egress logs, baseline.json,
                           # fidelity.json, summary.md
```
All chunk outputs are written under `runs/run-<id>/`; bare names below (`baseline.json`, etc.)
are always within that directory.

### Roles, containers, and isolation boundaries (validity lives here)
| Role | Container / workspace | Network | Touches oracle? |
|---|---|---|---|
| **Baseline cook** | container O: clone target @ pinned SHA, build, run suite, assert green | normal | yes — runs it (doesn't feed the seed) |
| **Author-creator cook** | container C: repo copy with the **oracle stripped (glob-based)**; runs seed-create + self-interview, stops at DRAFT | **off** | **no — actively withheld** |
| **Rebuild cook** | container R: **only the seed repo** | **allowlist only** (deps yes, target no) | **no** |
| **Scorer** (codified) | runs the oracle bundle against the rebuilt artifact → `fidelity.json` | n/a | yes — runs it (doesn't feed the seed) |

### Codified vs. agent-driven
- **Codified scripts** (deterministic, reusable): provision containers; clone+pin; build the
  glob-based stripped capture workspace; run baseline; provision + run the oracle bundle against
  the rebuild; emit `baseline.json` / `fidelity.json`; assemble `run-<id>/`; collect egress logs.
- **Agent-driven** (judgment): the capture (seed-create run + interview, stop at DRAFT); the blind rebuild.
- The sous orchestrates and **enforces blindness** via container network policy + workspace globs,
  proven by per-run egress logs.

## Target: oh-my-logo
`shinshin86/oh-my-logo` — the only candidate verified by *actually building it* (not by fetched
metadata, which is untrustworthy in this env). `config.json` **pins the exact SHA**; the spec does
not hard-code it. The baseline build (Chunk 2) is what *proves* the pin builds + the green count
(don't take 127/127 on faith — establish it at the pin).

## Metrics (v1)
- **baseline:** N/N green (sanity gate — abort the run if not green; the oracle is invalid otherwise).
- **fidelity:** X/N passing on the rebuild, **classified by failure type** so a low score is
  diagnosable: `build_failure` · `test_setup_failure` (runner/devDeps/config) · `import_failure`
  (API-surface mismatch) · `assertion_failure` (behavior gap) · `harness_failure`. Only
  assertion/import failures are genuine seed gaps; setup/harness failures indict the harness.
- lightweight (in `summary.md`): seed size, did-the-rebuild-build (y/n), wall time.

## Scope

**In (v1):** the four-stage loop on oh-my-logo, single rebuild, codified scaffolding + agent
capture/rebuild, network-enforced blindness, the classified run record.

**Out — deferred deliberately so v1 ships:** the **harden loop** (iterate gaps → re-rebuild →
iterations-to-green); **multi-run averaging** (one rebuild is non-deterministic — the v1 number is
a smoke signal, NOT decision-grade for A/B); **A/B of Greenfield techniques** (the eventual
purpose; needs multi-run + a baseline first); **train/test split** (creator sees a subset, score on
a disjoint subset); **separated creator/author cooks**; a **second target** (n8n starter-kit, the
orchestrator-seed experiment).

## Chunks

Global Constraints (apply to every chunk):
- **Network-enforced blindness is the top invariant.** Capture container C = network off; rebuild
  container R = dependency allowlist only (deps yes; target package AND its repo NO). Every run
  emits egress/blocked-host logs as positive proof. Filesystem stripping alone is never sufficient.
- **The oracle bundle is one inventory.** A single manifest (Chunk 1) defines, by glob/file, every
  oracle artifact (tests incl. co-located, fixtures, snapshots, runner config, devDeps, test cmd).
  It drives BOTH capture-withhold and scorer-run. Never key isolation on "the test dir."
- **Capture stops at DRAFT.** `SEEDCREATE_RESULT=DRAFT`; do NOT run seed-create's own harden loop in v1.
- **Fail clearly, no fallbacks.** Baseline not green → abort (oracle invalid). Don't paper over a broken stage.
- **Pin everything** (target SHA, base images, tool/runtime versions; no floating `latest`); prove pins by building.
- **Hybrid by design:** mechanical steps codified; only capture + rebuild are agent-driven. Preserve exact prompts/tool logs for both.
- **Everything lands in `runs/run-<id>/`.**

### Chunk 1: eval scaffolding + oh-my-logo config incl. oracle manifest
Implements: §Architecture (layout) + §Target + §Methodology (oracle bundle)
Interfaces: produces `targets/oh-my-logo/config.json` — repo URL, pinned SHA, base image, build
cmd, test cmd, devDeps, and an **oracle manifest** (globs for tests/fixtures/snapshots/config) —
consumed by Chunks 2–5 as the single source of truth for withhold + score.
Done when: the `eval/` tree exists; `config.json` carries a real pinned SHA + build/test commands +
an oracle manifest whose globs are confirmed against the actual file layout at that SHA; a loader
reads it. (Verification of "does it build" belongs to Chunk 2, not here.)

### Chunk 2: baseline harness
Implements: §loop step 1 + §Metrics (baseline)
Interfaces: consumes `config.json`; produces `baseline.json`.
Done when: it provisions container O, clones oh-my-logo @ the pinned SHA, builds, runs the oracle,
and emits `baseline.json` with the real green count established at the pin; aborts loudly if not green.

### Chunk 3: capture container + author-creator run (network off, stop at DRAFT)
Implements: §loop step 2 + §Methodology (A, B, interview contract) + §Artifacts
Interfaces: consumes `config.json` (uses the oracle manifest to strip); produces the **seed repo**
+ interview transcript + tool logs + capture egress log.
Done when: a script builds container C with the oracle **glob-stripped** (manifest-driven; proven by
a workspace manifest showing none of the oracle globs present) and **network off** (proven by a
blocked-egress log); the author-creator cook runs seed-create against it, answers the fixed interview
contract, **stops at `SEEDCREATE_RESULT=DRAFT`**, and emits a seed repo; transcript + tool logs +
egress log saved to the run record.

### Chunk 4: clean-room blind rebuild (allowlist network)
Implements: §loop step 3 + §Methodology (B) + §Artifacts
Interfaces: consumes the **seed repo**; produces the rebuilt artifact in container R + rebuild egress log.
Done when: container R is provisioned with **only the seed repo** and a **dependency allowlist that
excludes the target package and its repo** (proven by an egress log showing deps resolved and any
attempt to reach the target blocked); a rebuild cook hydrates the seed and builds; the rebuilt
artifact (or a captured build failure) is recorded.

### Chunk 5: scorer (oracle bundle vs. rebuild, classified)
Implements: §loop step 4 + §Metrics (classified fidelity)
Interfaces: consumes the rebuilt artifact + the oracle bundle obtained from `config.json` @ SHA;
produces `fidelity.json`.
Done when: the codified scorer provisions the runner + devDeps + config/fixtures/snapshots from the
oracle manifest, binds the original tests' imports to the rebuilt module surface (defined mount
point), runs them, and emits `fidelity.json` with the pass count out of N **and each failure tagged
by class** (build/test_setup/import/assertion/harness).

### Chunk 6: end-to-end run orchestration + auditable record
Implements: all stages assembled + §Architecture (run record) + §Metrics (lightweight)
Interfaces: consumes Chunks 1–5; produces a complete `runs/run-<id>/`.
Done when: one command runs the full loop on oh-my-logo and produces a `run-<id>/` containing the
seed repo, container + egress logs, interview transcript + tool logs (capture and rebuild both
preserved for audit), `baseline.json`, `fidelity.json`, and `summary.md` stating baseline N/N,
classified fidelity X/N, seed size, and wall time — i.e. the loop has turned end-to-end once, auditably.
```
