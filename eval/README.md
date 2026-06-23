# seed-create eval harness

Measures **fidelity**: run `seed-create` on real software, rebuild that software from the
resulting seed in a network-isolated clean room, and score the rebuild against the original's
own (held-out) test suite. See `../docs/superpowers/specs/2026-06-23-seed-create-eval-harness-design.md`.

## Layout
```
eval/
  harness/                 # codified mechanical scripts
    load-config.mjs        # Chunk 1: load/validate a target config; --verify anchors + checks the manifest
    baseline.sh            # Chunk 2: clone@SHA -> --verify gate -> container O build+test -> baseline.json
    emit-baseline.mjs      # Chunk 2: parse vitest report + manifest cross-check -> baseline.json (loud abort)
  targets/
    oh-my-logo/
      config.json          # source pin (repo+SHA), base image, install/build/test cmds, devDeps,
                           # and the ORACLE MANIFEST (globs for tests/fixtures/snapshots/config,
                           # the lockfile, and documented test-shaped exclusions)
  runs/
    run-<id>/              # the ONLY output location (gitignored; reproducible by re-running)
```

## The oracle manifest is one inventory
`config.json#oracle` defines, by glob/file, every held-out test artifact AND the inputs needed to
run it deterministically. The SAME inventory drives BOTH capture-withhold (Chunk 3 strips these)
AND scorer-run (Chunk 5 runs these). Never key isolation on "the test dir." It includes:
- `tests` / `config` / `fixtures` / `snapshots` — globs for the test surface (fixtures/snapshots
  must be declared even when empty, so "none" is a reviewed decision, not an omission);
- `lockfile` — `package-lock.json` @ SHA, the deterministic dep pin (installs use `npm ci` against
  it). Withheld from capture (it's an oracle-running input, not capability context); used by the
  baseline (Chunk 2) and scorer (Chunk 5);
- `excludedTestShaped` — test-shaped files deliberately NOT in the oracle, each with `reason` +
  `evidence` (e.g. `scripts/test-filled-mode.sh`, a manual non-deterministic dev smoke);
- `expected.testFiles` — the exact files the globs must expand to at the SHA.

## Loader (Chunk 1)
```bash
node harness/load-config.mjs oh-my-logo                 # validated summary
node harness/load-config.mjs oh-my-logo --json          # validated config as JSON
node harness/load-config.mjs oh-my-logo --verify <dir>  # confirm a checkout matches the manifest
```
`--verify <dir>` is a precondition gate. Against a checkout it, in order:
1. **anchors** — asserts `<dir>` is a git checkout whose `HEAD == source.sha` (a fake dir or a
   wrong-SHA checkout FAILS; verification only means anything against the pin);
2. **matches** — expands the oracle globs and requires they equal `expected.testFiles` (+ config),
   no missing/extra;
3. **lockfile** — asserts `oracle.lockfile` is present at the SHA;
4. **completeness** — scans the tree for test-shaped files (`*.test.*`, `*.spec.*`, `__tests__/**`,
   `test*.sh`) and FAILS on anything present-but-not-inventoried (and not in `excludedTestShaped`),
   so manifest rot can't hide.

Exit codes: `0` ok · `1` invalid config · `2` verification mismatch. Pure Node (no third-party
deps, no `fs.globSync`); runs on the configured `node:20.18.1` runtime (asserts Node >= 18).
`loadConfig()` is importable and throws `ConfigError` on bad config.

## Baseline harness (Chunk 2)
```bash
harness/baseline.sh [target] [run-id]    # default target oh-my-logo; run-id defaults to a UTC stamp
```
Establishes the green count **at the pin** (don't take any count on faith). Pipeline:
1. **clone @ SHA on the host** — the pinned base image `node:20.18.1-bookworm-slim` omits git, so
   container O does not clone; the host (which has git) clones and checks out `source.sha`.
2. **`--verify` gate** — runs the loader's `--verify` against the checkout; aborts before building
   if the manifest doesn't match the real layout at the SHA.
3. **container O** — `node:20.18.1-bookworm-slim`, normal network: `npm ci` (against the pinned
   `package-lock.json`) → `npm run build` (`tsc`) → `npx vitest run` with a JSON report.
4. **parse + cross-check + emit** — `emit-baseline.mjs` reuses `loadConfig()`, parses the vitest
   report, cross-checks the files vitest actually ran against `oracle.expected.testFiles`, and
   writes `runs/run-<id>/baseline.json`.

**Loud abort, no fallbacks** (a non-green oracle is invalid): exit `2` suite not fully green ·
`3` manifest divergence (vitest ran a different set than the manifest claims — caught here at the
pin, not misread later as low rebuild fidelity) · `4` no/unusable test report (install/build/test
failed). `baseline.json` records the failure even when aborting.

Outputs under `runs/run-<id>/`: `baseline.json`, `clone.log`, `verify.log`, `container.log`, and
the `workspace/` checkout. Established baseline for oh-my-logo @ v0.5.0: **127/127 green**.

## Scope boundary
Chunk 1 produces the config + loader. Chunk 2 proves the pin builds and establishes the green
count. Chunks 3–5 (capture / rebuild / score) and Chunk 6 (end-to-end run record) follow.
