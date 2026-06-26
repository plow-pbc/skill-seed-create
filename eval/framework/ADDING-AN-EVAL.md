# Adding a new eval — quickstart

Self-service guide to add a new target (say a new app **DMP**) and start getting a trend
number for it. Every command below is real; run them from the eval root (`eval/`).

For the *concepts* (what seed-create is, the four-stage flow, the one-number model) see the
framework [`README.md`](README.md) first — this guide is the *how*.

---

## What an eval is

**One folder per target** — `evals/<name>/` — holding three things:

```
evals/<name>/
  eval.json        # the manifest: what to build, which environment, the scoring recipe
  source/          # the FULL project (the Seed Creator sees this). Materialized by Setup; gitignored.
  oracle/          # OUR hidden answer key (the Evaluator reads it; the agents never do):
    criteria.json  #   behavioral checks we author (product behaviour, machine-checkable)
    reference/     #   the original's captured evidence (CLI output / screenshots) to compare against
  runs/            # per-run output + runs/index.json trend rollup. Generated; gitignored.
```

You hand-write **`eval.json`** and **`oracle/criteria.json`**. Setup materializes `source/`
and captures `oracle/reference/` for you. Runs generate everything under `runs/`.

---

## Pick the environment

| `environment.type` | Use it for | How it runs | Run command |
|---|---|---|---|
| `docker`   | CLI tools, servers, anything that runs headless in a Linux container | agent + software co-located in a container; parallel runs | `framework/run.sh <name> --runs N` |
| `macos-vm` | macOS GUI / menubar / audio apps | host drives a headless macOS guest over SSH; serial runs | `framework/run-macos.sh <name> --runs N` |

Worked examples below: **`sample-cli`** (docker, tests-dominated) and **`sample-gui`** (macos-vm,
behavioural + screenshot, no tests).

---

## Step 1 — create the folder

```bash
mkdir -p evals/dmp/oracle
```

## Step 2 — write `eval.json`

Copy this template into `evals/dmp/eval.json` and edit. (Validated by
`framework/schemas/eval.schema.json`; `dispatch.mjs` rejects anything malformed.)

```json
{
  "name": "dmp",
  "environment": { "type": "docker", "image": "node:20.18.1-bookworm-slim", "pull": true },

  "source": {
    "repo": "https://github.com/acme/dmp.git",
    "ref":  "v1.0.0",
    "sha":  "0000000000000000000000000000000000000000"
  },
  "build": { "install": "npm ci", "build": "npm run build" },

  "tests": "npx vitest run",

  "scoring": {
    "note": "ONE composite TREND number; tests-dominated. Every component is also shown in the breakdown.",
    "components": [
      { "key": "projectTests", "weight": 0.55, "metric": "ratio", "evidence": "tests.json",     "num": "passed", "den": "M", "harnessGuard": "tests" },
      { "key": "build",        "weight": 0.20, "metric": "build" },
      { "key": "ourCriteria",  "weight": 0.10, "metric": "ratio", "evidence": "criteria.json",   "num": "passed", "den": "N" },
      { "key": "visual",       "weight": 0.10, "metric": "value", "evidence": "visual.json",     "field": "meanSimilarity" },
      { "key": "codeCopy",     "weight": 0.05, "metric": "boolPenalty", "evidence": "code-copy.json", "field": "flagged" }
    ]
  },

  "oracle": { "criteria": "oracle/criteria.json", "reference": "oracle/reference/" },

  "setup": {
    "referenceCaptures": [
      { "id": "render-default", "argv": ["DMP"] },
      { "id": "help",           "argv": ["--help"] }
    ],
    "testsLocked": "oracle/tests-locked",
    "testGlobs": ["__tests__/**/*.{test,spec}.{js,ts,tsx}", "vitest.config.ts"],
    "lockfile": "package-lock.json",
    "expectedTestCount": 12
  }
}
```

Field notes:

- **`name`** must equal the folder name (`evals/<name>/`).
- **`environment.image`** names this eval's build image. The framework ships no images — two modes:
  - **build-local**: a Dockerfile in the eval's own folder at `evals/<name>/images/<image>/Dockerfile`
    (`image` is then a logical tag). Used automatically when that file exists.
  - **explicit-external**: a registry/tag/digest-qualified ref (e.g. `node:20.18.1-bookworm-slim`)
    pulled at Setup — you MUST also set `"pull": true`. Setup **fails closed** (no Dockerfile + no
    `pull` ⇒ error), so a typo'd or squatted image name is never silently run.
  - (macos-vm uses a VM golden-image name via `environment.image`.)
- **`source`** — Setup clones `repo`, checks out the pinned **`sha`**, and asserts
  `HEAD == sha` (the `ref` tag is provenance only). Omit `source` if you commit a `source/`
  tree directly (some macos targets do).
- **`build`** — the install + build commands Setup runs in the environment.
- **`tests`** — OPTIONAL: the project's own test command. Present → the held-out test suite
  drives the number. Absent (e.g. dmp has no tests) → drop the `projectTests` component from
  the recipe and lean on behavioural criteria + visual (see the `sample-gui` example).
- **`scoring.components`** — the recipe (Step 4). **`setup`** — what Setup captures (Step 5).

## Step 3 — author the oracle (`oracle/criteria.json`)

These are **our** behavioural checks — *product behaviour a user would notice*, machine-checkable,
**not** implementation trivia. `criteria.json` self-declares its `count` (= number of criteria).

```json
{
  "version": 1,
  "count": 2,
  "criteria": [
    {
      "id": "renders-default",
      "description": "Running with text and no flags prints multi-line output (the core action).",
      "category": "user-visible",
      "tier": "graded",
      "check": { "type": "cli", "argv": ["DMP"], "expectExit": 0, "stdoutNonEmpty": true, "minLines": 3 }
    },
    {
      "id": "help-usage",
      "description": "--help prints usage and exits 0.",
      "category": "user-visible",
      "tier": "graded",
      "check": { "type": "cli", "argv": ["--help"], "expectExit": 0, "stdoutContains": ["usage"] }
    }
  ]
}
```

- **`category`** ∈ `user-visible | platform | persistence | error-empty-state`.
- **`tier`** ∈ `graded | gate` — informational only. **There are no gates**: "does it run"
  is the heavily-weighted `build` *input* to the number, never an artificial zero.
- **`check.type`** selects the checker:
  - **`cli`** (docker): run the built CLI with `argv`, assert over `expectExit` /
    `expectExitNonZero` / `stdoutNonEmpty` / `minLines` / `stdoutContains` / `stderrContains`
    / `stdoutMatches`.
  - **`guest-cli`** (macos-vm): run the built binary IN THE GUEST over SSH and assert over the
    same fields as `cli`. The host never runs the artifact.
- Write checks for **what the product does**, e.g. "renders ASCII art", "lists palettes",
  "errors on an unknown palette" — not "calls function X". Validate:

```bash
node framework/validate.mjs framework/schemas/criteria.schema.json \
     evals/dmp/oracle/criteria.json --assert-count count:criteria
```

You do **not** hand-write `oracle/reference/` — Setup captures it from the
`setup.referenceCaptures` invocations (CLI stdout for docker; the original's screenshots for GUI).

## Step 4 — understand the scoring recipe (the number)

The Evaluator rolls the recipe's components into **ONE composite trend number** (0–1, shown as
a %), computed by the shared `framework/composite-score.mjs`: a **weighted average over the
PRESENT components** (weights renormalize if one is absent). Each component reads one evidence
file via a **metric**:

| `metric` | meaning | fields |
|---|---|---|
| `ratio`       | `evidence[num] / evidence[den]`, clamped 0–1 | `evidence`, `num`, `den` |
| `value`       | a 0–1 field straight from evidence | `evidence`, `field` |
| `build`       | `buildOk ? 1 : 0` (the "does it run" input) | — |
| `boolPenalty` | `evidence[field]` truthy → 0, else 1 (penalty, never zeroes the whole number) | `evidence`, `field` |

- **`harnessGuard: "tests"`** — if the test *harness* couldn't run at all (a setup failure,
  not genuine test failures), that component is **excluded** (weights renormalize) and surfaced
  separately, so a harness hiccup never tanks the trend. (The Evaluator brings its own test
  runner, so a rebuild missing `vitest` still gets scored.)
- **Weights are per-project and tunable** — they're the right knob. Tests-dominated for a
  tested project; behaviour+screenshot for one without.

Evidence the stages emit (component → file): `projectTests → tests.json`, `ourCriteria →
criteria.json`, `visual → visual.json`, `codeCopy → code-copy.json`, plus `build` (no file).
A macos-vm target's recipe can name its own evidence files emitted by its guest scorers.

## Step 5 — Setup (once)

```bash
framework/setup.sh dmp          # docker      (or: framework/setup-macos.sh dmp)
```
Setup: materializes `source/` (clone @ pinned sha), builds the original, **green-gates** it
(its own tests pass + our criteria pass on the known-good original — a valid yardstick),
captures `oracle/reference/`, snapshots the held-out test copy, and captures the test
toolchain. It aborts loudly unless the original is fully green. A run is only trustworthy if
Setup is green.

## Step 6 — run it, read the number

```bash
framework/run.sh dmp --runs 5         # docker   (macos-vm: framework/run-macos.sh dmp --runs 5)
```
This drives all four stages (Setup → Seed Creator → Seed Installer → Evaluator), N times,
network-on with a post-hoc leakage audit (a run where the Installer fetched the real target is
INVALIDATED and re-run). Output:

- **`runs/<run-id>/score/scorecard.json`** — `composite.score` (the run's number) + the full
  `breakdown` (every component) + `harness[]` (any harness failures, shown separately).
- **`runs/<run-id>/`** — the complete run folder: `seed/ rebuild/{src,build}
  transcripts/{capture,rebuild}.jsonl egress.log score/ run.json`.
- **`runs/index.json`** — the rollup: **compositeScore mean ± stdev** over valid runs (the
  headline trend) + per-component means + per-run links.

```bash
node -e 'const j=require("./evals/dmp/runs/index.json");console.log(j.aggregate.compositeScore)'
```

The number is a **trend signal** — is seed-create holding/improving, are there regressions —
**not** a pass/fail bar.

---

## Worked example A — `sample-cli` (docker, tests-dominated)

A CLI with its own test suite. The recipe lets the tests drive the number; "does it build"
is a heavy input; a handful of behavioural criteria + visual + code-copy round it out.

`evals/sample-cli/eval.json` → `scoring.components`:
```json
[
  { "key": "projectTests", "weight": 0.55, "metric": "ratio", "evidence": "tests.json",     "num": "passed", "den": "M", "harnessGuard": "tests" },
  { "key": "build",        "weight": 0.20, "metric": "build" },
  { "key": "ourCriteria",  "weight": 0.10, "metric": "ratio", "evidence": "criteria.json",   "num": "passed", "den": "N" },
  { "key": "visual",       "weight": 0.10, "metric": "value", "evidence": "visual.json",     "field": "meanSimilarity" },
  { "key": "codeCopy",     "weight": 0.05, "metric": "boolPenalty", "evidence": "code-copy.json", "field": "flagged" }
]
```
Criteria are `cli` checks (e.g. renders default output, prints `--help`, errors on bad input).
A faithful rebuild lands a high composite — tests dominate, build 100%, criteria green, visual
~1.0 — read the exact number from `runs/index.json`.

## Worked example B — `sample-gui` (macos-vm, behavioural + screenshot, NO tests)

A macOS menubar app with no test suite. No `tests`, no `projectTests` component — the number is
behavioural checks + a blinded screenshot match.

`evals/sample-gui/eval.json` → `scoring.components`:
```json
[
  { "key": "runs",            "weight": 0.3, "metric": "ratio", "evidence": "behavior.json",     "num": "runsPassed",  "den": "runsTotal" },
  { "key": "showsState",      "weight": 0.2, "metric": "ratio", "evidence": "behavior.json",     "num": "showsPassed", "den": "showsTotal" },
  { "key": "controlImpacts",  "weight": 0.3, "metric": "ratio", "evidence": "behavior.json",     "num": "ctrlPassed",  "den": "ctrlTotal" },
  { "key": "screenshotMatch", "weight": 0.2, "metric": "value", "evidence": "visual-judge.json", "field": "score01" }
]
```
Criteria use `check.type: "guest-cli"` driven over SSH; `reference/` holds the original's
screenshots. Run with `run-macos.sh`. Read the composite from `runs/index.json`.

---

## One-screen recap

1. `mkdir -p evals/<name>/oracle`
2. Write `evals/<name>/eval.json` (template above) — environment, source, build, **scoring recipe**.
3. Write `evals/<name>/oracle/criteria.json` — product-behaviour checks; `validate.mjs` it.
4. `framework/setup.sh <name>` — materialize + green-gate + capture reference (once).
5. `framework/run.sh <name> --runs 5` — get `runs/index.json` (composite mean ± stdev).
6. Read the trend; tune `weights` in `eval.json` if the mix isn't right.
