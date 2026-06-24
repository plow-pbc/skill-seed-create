# seed-create Eval Harness — Methodology & Findings (v1)

**Status:** v1 complete. The loop turns end-to-end on `oh-my-logo`. This doc captures the reusable-
workflow knowledge (it is the durable home for findings that otherwise live only in transient notes).
See the design spec at `docs/superpowers/specs/2026-06-23-seed-create-eval-harness-design.md`.

## What this is
The first objective measurement instrument for `seed-create`: run seed-create on real software,
rebuild that software from the resulting seed in a clean room (blind to the original's tests), and
score the rebuild against the original's held-out test suite → a classified **fidelity** number.

## How to run
```
eval/harness/run-eval.sh oh-my-logo <run-id>
```
Runs baseline → blind capture → clean-room rebuild → classified scoring under ONE canonical run-id,
producing a complete auditable `eval/runs/run-<run-id>/` (seed, both cook transcripts + tool logs,
egress/blindness/strip proofs, vendor listing, baseline.json, fidelity.json, binding-hashes.json,
summary.md).

## First results (v1 smoke signal — 3 runs, identical harness)
| run | fidelity | breakdown | note |
|---|---|---|---|
| run-r2 | 16/127 (12.6%) | import 34, assertion 77 | rebuild omitted a whole module |
| run-e2 | 27/127 (21.3%) | import 0, assertion 100 | reconstructed all modules |
| run-e3 (canonical) | 27/127 (21.3%) | import 0, assertion 100 | 3-file seed; palette hex guessed from names |

`build`/`test_setup`/`harness` = 0 in every run → the harness never inflates or hides. A description-
only seed reconstructs *buildable* code that is only ~13–21% *behaviorally* faithful. The run-to-run
spread is itself the finding: one rebuild is a smoke signal, not decision-grade.

## Methodology findings

### Eval methodology
1. **Test-blindness has THREE axes** — network, filesystem, AND agent prior-knowledge. The oracle-
   manifest author may never be the capture agent (a memory leak no gate can catch).
2. **By-construction beats filtering** — vendored deps (target simply absent) and freeze-then-collect
   (no live process to mutate files) ended leaks that pattern-filtering could not.
3. **The oracle's metadata hides in ordinary docs** — README/CLAUDE.md listed test files + counts;
   stripping test *files* is necessary but not sufficient (redact metadata in retained prose too).
4. **Classify fidelity** — "compiles clean but wrong API surface" (import) vs "wrong behavior"
   (assertion) vs build/test_setup/harness; only the breakdown makes a low number diagnosable.
5. **One run is a smoke signal** — empirically proven by the 16-vs-27 spread; v2 needs multi-run averaging.

### Build / orchestration
6. **Cross-backend adversarial review is load-bearing** — every Critical came from the opposite-backend
   reviewer (codex vs claude); same-family review would have shipped porous gates.
7. **Isolation harnesses need a SECURITY pass, not just correctness** — bypasses cluster at host↔
   container trust seams (prefix-only docker-exec host-escape → symlink-via-copy → TOCTOU race); the
   proof suite must exercise adversarial bypass vectors, not just expected patterns.
8. **seed-create friction for automation** — its interactive hard-gate (no writes without approval,
   one-question-at-a-time) had to be self-approved via a fixed contract; and it is non-deterministic
   about whether it bundles source (forced the "strip bundled source before scoring" decision). A
   non-interactive mode would help if seed-create is to be eval-driven.

## How validity is enforced (the invariants)
- **Capture container:** network OFF; oracle glob-stripped (incl. lockfile + redacted doc metadata);
  capture agent is a fresh, manifest-naive `claude -p` subprocess, tool-confined to the stripped
  workspace. Positive proof: blocked-egress log (git + npm) + filesystem-blindness probe suite.
- **Rebuild container:** fully net-off; pre-seeded VENDORED deps with the target absent by construction
  (target is its own lockfile root → `npm ci` installs only deps). Proof: vendor listing (target
  absent, full-tree + alias scan) + blocked egress.
- **Collection seams:** one shared `safe_collect` helper — freeze (`docker stop`) the cook before
  collecting + `O_NOFOLLOW` — refuses symlinks, copies no-deref, asserts regular-files-in-tree.
- **Scoring:** held-out oracle run unmodified against the rebuilt module surface; fail-closed sha256
  binding proof (aborts rather than emit a number if the rebuild can't be proven bound); strict green
  (skipped/not-collected = a real gap, never a pass); discovered-vs-expected manifest cross-check.

## v2 backlog
- Cooks fully in-container (net-off except a narrow model-API allowlist) — airtight isolation by
  construction. NOTE: does not retire the host-side collection seam (handled by freeze + safe_collect).
- Multi-run averaging — turn the smoke signal into a decision-grade number.
- The harden loop (iterate gaps → re-rebuild → iterations-to-green).
- A/B of seed-create techniques (the eventual purpose; needs multi-run + a baseline first).
- Train/test split (creator sees a subset, score on a disjoint subset).
- A second target (e.g. the n8n starter-kit orchestrator-seed experiment).
