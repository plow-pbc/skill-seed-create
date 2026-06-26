# Seed-eval framework

Measures whether **seed-create** can capture a working app into a SEED that a *blind* agent
rebuilds faithfully — reported as ONE composite **trend number** per target (is the skill
holding / improving as we change it; catch major regressions — not a pass/fail bar). Two
environments share one scorer: **docker** (headless Linux container) and **macos-vm** (host
drives a headless macOS guest over SSH).

## Start here

- **New to the model?** → [`docs/eval-framework.md`](../../docs/eval-framework.md) — what
  seed-create is, the four-stage flow (Setup → Seed Creator → Seed Installer → Evaluator),
  and the one-number model. The concepts; this file is the internals.
- **Adding or running an eval?** → **[`ADDING-AN-EVAL.md`](ADDING-AN-EVAL.md)** — the
  step-by-step quickstart: create the folder, write `eval.json` + the scoring recipe, author
  the oracle, Setup, run, read the number — with copy-paste templates + worked examples
  (a CLI/docker target and a GUI/macos-vm target).

```bash
framework/setup.sh <target>                # once: materialize source + green-gate + capture reference
framework/run.sh   <target> --runs 5       # docker lane   → runs/index.json (composite mean ± stdev)
framework/run-macos.sh <target> --runs 5   # macos-vm lane
```

> Note: the original **hard-gate** model (a gate failure forcing the score to 0) was
> **superseded** by the composite-recipe scorer — there are **no gates**; "does it run" is a
> heavily-weighted *input*. See the quickstart for the current model.

---

## Internals & reference (by build chunk)

The rest of this document is implementation reference, organized by the build chunks that
produced each piece.

## Layout

```
evals/<target>/
  eval.json          # the manifest (validated against framework/schemas/eval.schema.json)
  source/            # the FULL project — materialized by Setup (clone @ pinned sha). gitignored.
  oracle/            # OUR hidden material — read only by the Evaluator, never the agents:
    criteria.json    #   behavioral checks (schema: criteria.schema.json; content = Chunk 3)
    reference/       #   captured reference evidence (Setup) + index.json
    tests-locked/    #   held-out snapshot of the project's tests (Setup) — scorer-only
    setup.json       #   Setup report: build ok + oracle-green verdict + reference/snapshot manifests
  runs/              # per-run outputs (Chunk 4) + index.json rollup. gitignored.

framework/
  schemas/{eval.schema.json, criteria.schema.json}   # the two Chunk-1 schemas
  validate.mjs       # dependency-free JSON-schema validator (+ --assert-count)
  dispatch.mjs       # the thin dispatcher: eval.json -> resolved {runner, oracle, tests-cmd, ...}
  setup.sh           # the Setup stage (docker runner)
  capture-reference.mjs / snapshot-tests.mjs / setup-report.mjs   # Setup helpers
  images/<image>/Dockerfile                          # logical images the runner resolves
```

## The two schemas

- **`eval.schema.json`** — the manifest. Required: `name`, `environment{type,image}`,
  `oracle{criteria,reference}`, `setup{referenceCaptures,testsLocked,…}`. Optional:
  `source{repo,ref,sha}` (Setup clones it; omit for a committed source/ with no upstream repo),
  `build{install,build}`, `tests` (the project's own test command, scored from the
  held-out copy). `environment.type ∈ {docker, macos-vm}` selects the runner (§8).
- **`criteria.json`** — our behavioral criteria (§6). Records its **own** `count`
  (the Evaluator discovers N; no hardcoded numbers) — `validate.mjs --assert-count
  count:criteria` asserts `count == criteria.length`. Each criterion is product-behavior
  (`category ∈ {user-visible, platform, persistence, error-empty-state}`), `tier ∈
  {gate, graded}` (a `gate` failure forces the graded score to 0), and an open `check`
  object whose concrete types the Evaluator defines. Each target authors its own
  `criteria.json` alongside its eval.

Validate:
```bash
node framework/validate.mjs framework/schemas/eval.schema.json     evals/sample-cli/eval.json
node framework/validate.mjs framework/schemas/criteria.schema.json evals/sample-cli/oracle/criteria.json --assert-count count:criteria
```

## The dispatcher

Reads `evals/<target>/eval.json`, validates it, and resolves it into the config the
stages consume — selecting the **environment runner** (§8):
```bash
node framework/dispatch.mjs sample-cli            # human summary
node framework/dispatch.mjs sample-cli --runner   # -> docker
node framework/dispatch.mjs sample-cli --json     # resolved config (abs oracle paths, runner, …)
```
Runners: `docker` (agent+software co-located, handle `docker exec`, parallel);
`macos-vm` (host drives a guest over SSH, handle `ssh-to-guest`, serial).

## Setup (the green-gate)

```bash
framework/setup.sh sample-cli
```
1. **materialize** `source/` (clone @ pinned sha; anchor HEAD==sha),
2. **build** the original in the environment (`npm ci && npm run build`),
3. **assert the oracle is green** on the known-good original — at Chunk 1 the green
   signal is the project's own tests (`npx vitest run`, expect 127/127); our-criteria
   green-check arrives with Chunk-3 content,
4. **capture reference** evidence (built-CLI invocations → `oracle/reference/<id>.txt` + `index.json`),
5. **snapshot the held-out test copy** (`setup.testGlobs` + lockfile → `oracle/tests-locked/`),
   so the Evaluator never runs the mutable `source/` tree,
6. emit `oracle/setup.json` and **abort non-zero** unless build-ok + fully green.

A run is only trustworthy if Setup is green. `oracle/` and `tests-locked/` are never
materialized into a Creator/Installer workspace (Global Constraints).

## The Evaluator (Chunk 2 — the composable scorer)

```bash
framework/evaluate.sh <target> --rebuild <install-dir> --seed <seed-dir> \
  [--criteria <file>] [--label <name>]
```
Scores an **installed artifact** against the hidden oracle and emits one
`runs/<label>/score/scorecard.json` (+ `score/evidence/`) merging **both §6 dimensions**:

- **Dimension 1 — fidelity** (all three sections, declared by the manifest):
  - **our-criteria → X/N** (`criteria-check.mjs`): runs each criterion's machine-check
    against the install. Chunk-2 defines the `cli` check type (docker/CLI lane): run the
    built CLI with `argv`, assert over `expectExit`/`expectExitNonZero`/`stdoutContains`/
    `stderrContains`/`stdoutNonEmpty`/`minLines`/`stdoutMatches`. `tier:"gate"` criteria are
    **hard gates**.
  - **project-tests → X/M** (`score-tests.mjs`): runs the **held-out `tests-locked/` copy**
    against the install's module surface (evaluate.sh strips any tests the artifact carries
    and overlays the locked copy), parses vitest JSON, classifies setup/build failures.
  - **visual** (`visual-terminal.mjs`): the docker lane's terminal-output scorer — a
    **blinded structural** rubric (ANSI-stripped; line/char/word-token features, **not**
    byte-diff) comparing the install's output on the reference `argv` to `oracle/reference/`.
- **Dimension 2 — seed quality** (`code-copy.mjs`): verbatim-code volume in the seed —
  **code-fence ratio** + **longest verbatim block** (line-level longest-common-substring vs
  `source/`) + total verbatim lines. Flags a **source-dump** even if it rebuilds. Thresholds
  (a Chunk-2 deliverable) are recorded in the output: fence-ratio > 40%, verbatim block ≥ 10
  lines, or ≥ 60 verbatim lines.

`emit-scorecard.mjs` merges the sections, applies the **composition rule** (a hard-gate
failure ⇒ *not a successful install*; otherwise sections report independently, project-tests
as the high-resolution headline and our-criteria as the cross-target-uniform headline), and
attaches a per-miss **failure attribution** into the five §6 categories (seed-omission /
seed-ambiguity / installer-failure / oracle-overreach / environment-limitation). Attribution
is heuristic and named as such: it cross-references the seed text (does the seed mention the
missed behavior? → installer-failure vs seed-omission) and the project tests (our-criterion
fails while project-tests are green → oracle-overreach). Judgment-based attribution is later.

The scorer is validated both ways against a target's own evals: a **green** install (the
known-good original) scores full fidelity with a low code-copy ratio, while a **broken +
source-dumped** install trips its hard-gate criteria, drops project-tests/visual, and is
**source-dump-flagged** by code-copy — exercising the composition rule and the
failure-attribution categories.

## Oracle authoring + calibration discipline

Each target authors `evals/<target>/oracle/criteria.json` — N product-behavior criteria
(1+ hard gate + graded), all machine-checkable, no implementation trivia — and Setup asserts
they score **fully green on the known-good original** (a valid yardstick). (`criteria.schema.json`
carries an optional root `note`/`$comment` for authoring provenance.)

**Calibration (§9)** is the discipline of checking, for a target whose project has its own
tests, that our-criteria *tracks* that test suite across a deterministic fidelity spectrum
(the original + a few targeted breaks). The stated acceptance bar: (1) yardstick — original
100%/100%; (2) co-movement — Spearman ρ ≥ 0.80; (3) no-false-green — no install ≥90% criteria
while <80% tests; (4) directionality — every regression drops both signals. Coarse criteria
are typically *more sensitive per-regression* than the aggregate test % (a broken subsystem
trips a couple of criteria but only a handful of tests) yet co-move tightly by rank.
Calibration installs are deterministic code variants (one exact score each); the §4 N=5
averaging is for non-deterministic LLM installs. This calibrates the *discipline* on a
test-bearing target; it does not certify a cross-modal GUI/audio oracle. (When real
Seed-Installer runs land, re-read calibration on those, watching the §7 test-derived-seed
circularity — an honest limit to note then, not a guard to build now.)

## End-to-end integration + leakage + multi-run (Chunk 4)

```bash
framework/run.sh <target> [--runs N]      # default N=5
```
Drives all four stages NETWORK-ON into the complete §5 run folder, N times, → `runs/index.json`.
Blindness is by workspace contents + post-hoc audit + denylist (Global Constraint: no net-off).

- **egress proxy** (`egress-proxy.mjs`): the capture/install containers route all traffic
  through it (`HTTPS_PROXY` + npm `registry`). Logs every npm package fetch (registry mode,
  with package path) and every CONNECT host:port to `egress.log`. For published targets it
  enforces the **active denylist**: 404 the target package, 403 the target repo host — while
  allowing deps. Proven in a container: a dependency-package install **ALLOWs**, the target
  package install **DENY (404)**, `git clone <target-repo>` **DENY (403)**, all logged. (Residual,
  §7: a direct target-tarball over the shared-TLS registry host can't be blocked at the host
  level — the post-hoc audit catches it.)
- **leakage audit** (`leakage-audit.mjs`): post-hoc over `egress.log` + `rebuild.jsonl` →
  `score/leakage-audit.json` (`pass` | `INVALIDATED`). An ALLOWED target fetch (egress) or a
  not-proven-blocked target fetch (transcript) ⇒ **INVALIDATED** (exit 8); `run.sh` discards +
  re-runs it (not counted toward N). Proven: planted target-fetch → INVALIDATED; clean → pass.
  Named residual: weight-memorization (zero-egress reproduction of a popular published package)
  is invisible — unpublished targets (no public package/repo) are immune.
- **multi-run / index** (`aggregate-index.mjs`): rolls up every run (scores + leakage verdict +
  links) → `runs/index.json` with **mean ± stdev over VALID runs** (INVALIDATED excluded).
  Proven on 5 real scorecards (our-criteria 78.6% ± 24.7, project-tests 97.4% ± 3.1; with one
  planted-INVALIDATED run correctly excluded: total 5 / valid 4).
- **run folder** (per §5): `seed/ rebuild/ transcripts/{capture,rebuild}.jsonl egress.log
  score/{scorecard.json,evidence,leakage-audit.json} run.json`. The Creator agent sees full
  `source/`; the Installer agent gets the seed alone (`strip-seed-source` re-strips any bundled
  source/tests); confinement is the FIXED `agent-tool-guard` (file tools → workspace; Bash → one
  `docker exec`), now over a NET-ON proxied container (`stage-agent.sh`).
