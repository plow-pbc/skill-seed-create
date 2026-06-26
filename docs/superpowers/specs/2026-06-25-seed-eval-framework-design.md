# Seed Eval Framework — Design (v3)

**Date:** 2026-06-25 · **Status:** Draft for review (v3 — full-source model, named components, reviewer fixes applied)
**Vocabulary:** see the canonical reference `docs/eval-framework.md` (Setup / Seed Creator / Seed Installer /
Evaluator). This spec is the detailed design behind it.

## 1. Goal

Make "evaluating a seed" a **standard practice**: every eval is a folder + manifest running the same four
named stages, where the only real difference — Linux/CLI vs macOS/GUI — is declared config. Generalizes the
proven sample-cli harness into one framework that also covers sample-gui and any future seed.

## 2. Structure

```
evals/<target>/
  eval.json          # the manifest (§3)
  source/            # the FULL project — code + its tests if it has them.
                     #   The Seed Creator sees all of it. The Seed Installer never does.
  oracle/            # OUR evaluation material — hidden from BOTH the Seed Creator and the Installer.
    criteria.json    #   our behavioral checks (the things we verify in the output)
    reference/       #   the original's captured evidence (screenshots / video / output) to compare against
  runs/              # outputs — one folder per run (§5) + index.json rollup
```

**Full-source model (the realistic use case):** the Seed Creator gets the *whole* project, exactly as a real
seed-create run would — someone has working software and their agent reads its source. We do **not** strip
source. seed-create's job is to **extract the essence into prose, not copy the code** — and the Evaluator
*measures* whether it did (§6, dimension 2). `oracle/` is the only thing hidden from both agents.

## 3. The manifest — `eval.json`

```jsonc
// sample-cli — has its own tests
{ "name": "sample-cli",
  "environment": { "type": "docker", "image": "node20-eval" },
  "oracle": { "criteria": "oracle/criteria.json", "reference": "oracle/reference/" },
  "tests": "npm test" }            // OPTIONAL: the project's own tests (in source/), scored vs the install

// sample-gui — vibe-coded, no tests
{ "name": "sample-gui",
  "environment": { "type": "macos-vm", "image": "macos-golden" },
  "oracle": { "criteria": "oracle/criteria.json", "reference": "oracle/reference/" } }
```
Minimal: `name`, `environment {type, image}`, `oracle {criteria, reference}`, optional `tests`. Network-on and
fresh-per-run are framework defaults. `criteria.json` records its own expected count (the Evaluator discovers
N; no hardcoded numbers) — its schema is a Chunk-1 deliverable.

## 4. The four named stages

1. **Setup** — materialize `source/`, build the original, run the oracle on the *known-good original* to
   confirm it's green (a valid yardstick), and **capture reference evidence** into `oracle/reference/`. Also
   **snapshot a held-out copy of the project's `tests`** into scorer-only space here, so `source/` (which the
   Creator touches) is never the thing the Evaluator runs. A run is only trustworthy if Setup is green.
2. **Seed Creator** — run seed-create in the declared environment with the full `source/` visible → the
   **SEED**. Network on; `capture.jsonl` retained.
3. **Seed Installer** — a fresh, blind agent builds the capability **from the SEED alone** (no source, tests,
   or oracle — re-stripped from anything bundled in the seed before it runs), in the declared environment.
   Network on; `rebuild.jsonl` + `egress.log` retained.
4. **Evaluator** — score the installed software against the oracle → the **scorecard** (§6). Then the
   **leakage audit** (§7); a leaked run is invalidated.

Runs execute **N times** (default 5) and aggregate — a single install is non-deterministic and not
decision-grade (proven: repeated baseline runs of a single install spanned a wide range).

## 5. Inputs & the run-output contract

**In:** the Seed Creator gets `source/` → the **seed** → the Installer gets *only the seed* → the **installed
software**. The Evaluator uses the hidden `oracle/` + the scorer-only locked test copy.

**Out — one preserved folder per run:**
```
runs/<run-id>/
  run.json            # manifest: config snapshot, env+image, timestamps, status, leakage verdict, scores
  seed/               # THE SEED (Seed Creator output)
  rebuild/            # THE INSTALLED SOFTWARE — reconstructed code (src/) + built artifact (build/)
  transcripts/{capture.jsonl, rebuild.jsonl}   # retained for post-hoc review
  egress.log          # network egress during install (leakage-audit input)
  score/
    scorecard.json    # fidelity (criteria X/N + tests X/M + visual) + essence-extraction (code-copy) + attribution
    evidence/         # screenshots, video, raw test output
    leakage-audit.json# pass | INVALIDATED (+ what was fetched)
  run-summary.md
runs/index.json       # rollup: every run + scores + leakage verdict + links — the browsable log
```

## 6. The oracle & scoring — two dimensions

**Dimension 1 — Does the installed software work? (rebuild fidelity).** Composable, uniform sections, declared
by the manifest:
- **Our behavioral criteria** (`oracle/criteria.json`) → **X/N**. *Always present, even for sample-cli.*
  Machine-checkable, product-contract behaviors (user-visible · platform · persistence · error/empty-state),
  never implementation trivia. Includes **hard gates** (build/launch/core-action) whose failure forces the
  graded score to 0 (Tier-2 diagnostics still reported).
- **Visual similarity** (vs `oracle/reference/`) → rubric verdict. *Always present.* Screenshots/video of the
  installed software judged against the original's reference by a **blinded structural** rubric (not pixel-diff).
- **Project tests** (the `tests` command, run from the **scorer-only held-out copy** snapshotted at Setup) →
  **X/M**. *Only where the project has them.*

**Dimension 2 — Did the seed extract the essence, or just copy? (seed quality).** The Evaluator measures
**verbatim-code volume in the seed**: code-fence ratio + detection of large verbatim blocks matching the
original `source/`. A source-dump is flagged as a *bad seed even if it rebuilds* (it violates "ship the seed,
not the plant"). Reported alongside fidelity — a **great** seed is high-fidelity *and* low-code-copy.

The Evaluator emits one `scorecard.json` merging the fidelity sections + the essence/code-copy measure + a
**failure attribution** per miss (seed omission / seed ambiguity / installer failure / oracle overreach /
environment limitation). **Composition rule:** a hard-gate failure ⇒ "not a successful install" regardless of
other sections; otherwise sections report independently, with project-tests (where present) as the
high-resolution headline and our-criteria as the cross-target-uniform headline.

## 7. Blindness model: realism at capture, rigor at scoring

- **Capture/install = realistic.** Network on (proven plain-NAT flow). The Seed Creator gets `source/`; the
  Installer gets the seed.
- **Scoring = rigorous.** `oracle/` is hidden from both — benchmark labels the evaluated system never sees
  (like ImageNet labels / SWE-bench tests). The project's `tests` are scored from a **scorer-only held-out
  copy** (Setup snapshot), never the mutable `source/`.
- **Leakage audit (post-hoc, invalidating).** Every run logs egress + retains `rebuild.jsonl`. After scoring,
  an audit checks whether the Installer fetched **the target itself** (the real package/repo — not its deps).
  A leaked run is **invalidated and re-run**. Risk is *asymmetric*: high for a **published** target with an
  **automated** oracle (sample-cli: `npm install sample-cli` + re-export scores ~100% fraudulently), low for
  an **unpublished** behaviorally-judged one (sample-gui) — so published targets additionally get an **active target
  denylist** (block fetching the target package/repo, allow deps); unpublished targets rely on the audit alone.

**Known residual limits (named honestly):**
- **Weight-memorization.** The audit catches *fetching* the target but **cannot** catch an Installer that
  reproduces a *popular published* package (sample-cli) **from training memory, zero egress.** This is the most
  likely leakage path for published targets and is invisible to egress/denylist — so a published target's score
  may be partly memorization. **sample-gui (unpublished) is immune**, which makes it a *cleaner* target on this axis.
- **Test-derived-seed circularity.** When the project has tests, the Seed Creator may mine them into the seed;
  scoring the install against those same tests then partly measures "did the Installer follow the conveyed
  contract," not fully-independent capability. The §9 calibration must not be over-read because of this.

## 8. Environment forks (the two runners)

`environment.type` selects a runner; both drive the four stages but differ in *where the agent runs vs where
the build/oracle runs*:
- **`docker`** — agent and software co-locate in one container (Linux/CLI); the oracle's environment handle is
  `docker exec`; parallel-capable.
- **`macos-vm`** — the agent runs **on the host (neo) and drives a headless macOS guest over SSH** (push source
  in, build/oracle in the guest, pull evidence out); handle is `ssh-to-guest`; uses the `macos-golden`
  golden (clean of `oracle/`), network-on plain-NAT. **Serial** (~1 VM on 8 GB) — materially slower; the
  framework notes this, doesn't hide it.

## 9. Reference configs + calibration (narrowed)

| | **sample-cli** | **sample-gui** |
|---|---|---|
| environment | `docker` | `macos-vm` |
| `source/` | code **+ its own test suite** | the project's source, **no tests** |
| oracle (hidden) | our criteria + reference | our criteria + reference |
| `tests` | `npm test` (X/M) | — |
| scorecard | criteria X/N + visual + tests X/M + code-copy | criteria X/N + visual + code-copy |

**Calibration (honest scope):** sample-cli runs *both* our criteria *and* its unit tests, so we check whether
our-criteria **tracks** the unit-test score — calibrating the criteria/rubric **discipline** on a
deterministic-text target. It does **not** certify the **cross-modal GUI/audio** instantiation sample-gui relies on,
and (per §7) the unit-test signal can be co-confounded by a test-derived seed. So: calibrate the *discipline*
on sample-cli; treat sample-gui's visual oracle as *trusted-by-method, not certified-by-transfer*. Acceptance bar
for "tracks" is set in Chunk 3.

## 10. Reuse vs. new

- **Reuse (built + proven):** the docker capture→install→score loop, transcript capture, the unit-test scorer,
  the macOS VM toolkit (clone/run/screenshot/video, `macos-golden`, the 5-check oracle), the sample-cli
  result, the GUI target's drafted criteria. *(Some of these are referenced from the implementation
  notes and are not all committed in this repo.)*
- **New:** the `eval.json` manifest + thin dispatcher; the `evals/<target>/{source,oracle,runs}` restructure
  (migrating the v1 `eval/` tree); the composable **oracle/Evaluator** (criteria + visual + tests + code-copy →
  scorecard); the **oracle content** (sample-cli criteria + sample-gui criteria + reference evidence); the
  **`macos-vm` runner**; the **leakage audit + denylist + egress logs**; **multi-run** + `runs/index`.

## 11. Non-goals / open questions

- **Non-goals:** a live human-creator interview loop (seed-create's auto-answered interview stays; richer
  interviews later); graduated-dB audio scoring for sample-gui (VM can't honor it); byte/architecture source-clone.
- **Open (MVP-blockers flagged):** the `criteria.json` **schema** (Chunk 1 — blocks oracle authoring); the
  visual rubric judge (human vs blinded-LLM, Chunk 6); the calibration **acceptance bar** (Chunk 3 — gates §9);
  the exact **code-copy metric** thresholds (Chunk 2 — what code-fence ratio / verbatim-block size flags a dump).

---

## Chunks

Global Constraints (apply to every chunk):
- **No net-off.** Capture/install run network-on; blindness is enforced by *what's in the workspace* (full
  `source/`→Seed Creator only; seed→Installer only; `oracle/` + locked test copy→neither) + the post-hoc
  leakage audit, never by killing the network.
- **`oracle/` and the locked test copy are never materialized into the Creator or Installer workspace** — read
  only by the Evaluator. The Installer workspace is the seed alone; any bundled source/tests are re-stripped.
- **Every run emits the full §5 output folder** (seed / rebuild / transcripts / egress / scorecard / evidence /
  run.json); transcripts always retained; **egress logged every run, every environment.**
- **Multi-run by default** (N=5); report mean ± stdev, never a single-run number as decision-grade.
- **Criteria are product-behavior, not implementation trivia**; and the seed is graded on **essence-extraction**
  (low verbatim-code), so the framework must never *reward* source-dumping.

### Chunk 1: Manifest + dispatcher + `evals/` restructure + criteria schema + Setup green-gate
Implements: §2, §3, §4-Setup, §8 (runner-selection seam)
Interfaces: produces the `eval.json` schema, the **`criteria.json` schema** (MVP-blocker), and a loader →
resolved config { environment-runner, oracle spec, tests-cmd? }; consumes the existing sample-cli harness.
Done when: `evals/sample-cli/{eval.json, source/, oracle/, runs/}` exists; the dispatcher selects the docker
runner; **Setup builds the original, asserts the oracle is green, captures reference, and snapshots the
held-out test copy**; both schemas are documented + validated on the sample-cli manifest.

### Chunk 2: The Evaluator — composable scorer (fidelity + visual + code-copy) + scorecard
Implements: §6 (both dimensions), §5 (score/ outputs)
Interfaces: consumes an installed artifact + resolved oracle spec + a **fixture `criteria.json`** (not Chunk
3's real content); produces `score/scorecard.json` (criteria X/N + project-tests X/M + visual verdict +
**code-copy measure**) + `score/evidence/` + failure attribution. Includes the **terminal-output visual**
scorer so the docker lane emits the promised visual section.
Done when: scoring sample-cli's install with a fixture criterion + the project tests emits a complete scorecard
(all promised sections incl. visual + code-copy) green on the known-good original; failure attribution + a
flagged code-copy appear on a deliberately broken / source-dumped install.

### Chunk 3: sample-cli oracle content (our criteria + reference) + calibration readout
Implements: §6, §9
Interfaces: consumes sample-cli behavior; produces `evals/sample-cli/oracle/{criteria.json, reference/}`.
Done when: our-criteria scores the known-good original at/near 100%; a multi-run comparison reports whether
our-criteria tracks the unit-test score (the calibration readout) **with the acceptance bar stated**.

### Chunk 4: Leakage audit + target denylist + egress logging + multi-run/index
Implements: §7 (leakage + denylist), §4 (multi-run), §5 (index.json)
Interfaces: consumes `egress.log` + `rebuild.jsonl`; produces `leakage-audit.json` (pass|invalidated), the
active **target denylist** for published targets, and the `runs/index.json` rollup (mean ± stdev).
Done when: a planted target-fetch is detected → run INVALIDATED + re-run; the denylist blocks fetching the
target package/repo while allowing deps; N=5 aggregates into `index.json`; egress logged every run.

### Chunk 5: The `macos-vm` environment runner
Implements: §8 (macos-vm), §4 (stages over SSH)
Interfaces: consumes a `macos-vm` resolved config; produces the same §5 output folder by driving the
`macos-golden` guest over SSH (push source / build+oracle in guest / pull evidence), network-on plain-NAT,
image clean of `oracle/`.
Done when: a trivial macos-vm eval runs Setup→Seed-Creator(host)→Seed-Installer(guest)→Evaluator end-to-end
producing the §5 folder; **egress captured over plain-NAT and the leakage audit runs on this lane**; the guest
image is verified clean of `oracle/`.

### Chunk 6: sample-gui oracle content + behavioral-visual scorer + first sample-gui runs
Implements: §6 (behavioral + visual), §9 (sample-gui)
Interfaces: consumes the sample-gui behavioral-oracle draft (behavioral criteria + reference plan); produces
`evals/sample-gui/oracle/{criteria.json, reference/}` + the screenshot/video capture + the blinded rubric judge.
Done when: sample-gui runs end-to-end on the macos-vm runner producing a tiered scorecard (gates + X/N + visual
verdict + code-copy) with evidence; the isolation criterion uses the corrected two-tone method; VM-untestable
items excluded.
