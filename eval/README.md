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
    lib.sh                 # Chunk 2: shared shell helpers (log/abort/saferm/cfg/require_cmd)
    strip-oracle.mjs       # Chunk 3: manifest-driven oracle strip of the capture workspace
    assert-stripped.mjs    # Chunk 3: prove zero oracle artifacts survive; package.json retained
    cook-tool-guard.mjs    # Chunk 3: PreToolUse blindness gate (file tools->workspace, Bash->net-off C)
    assert-blindness.mjs   # Chunk 3: POSITIVE proof the guard denies every route to the oracle
    capture-build-c.sh     # Chunk 3: build container C; prove network-off + filesystem blindness
    capture-run-cook.sh    # Chunk 3: run the fresh author-creator cook (3-axis confined) to DRAFT
    cook-transcript-summarize.mjs  # Chunk 3: stream-json transcript -> readable + tool log
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

## Capture — THREE-AXIS blindness (Chunk 3)
The top invariant: the seed must be created without the oracle. Blindness has **three axes**, all
enforced and all proven positively:
1. **Network** — the capture runs against a `--network none` container; both target-recovery paths
   (`git clone`, `npm install`/`npm view`) are proven blocked.
2. **Filesystem** — the cook's file tools (Read/Glob/Grep) are hook-confined to a **single stripped
   workspace**; any escape (absolute path, `..`, symlink, the oracle manifest) is **denied**.
3. **Agent prior-knowledge** — the cook is a **separate, fresh** agent given no manifest, no test
   names/counts; whoever builds the harness (and thus reads `config.json`) is NOT the cook.

```bash
harness/capture-build-c.sh [target] [run-id]   # build container C + PROVE all confinement axes
harness/capture-run-cook.sh <run-id>           # run the fresh author-creator cook to DRAFT
```
**`capture-build-c.sh`** clones @ SHA on the host, runs the **manifest-driven oracle strip**
(`strip-oracle.mjs` removes every oracle glob + the lockfile; `assert-stripped.mjs` proves zero
oracle artifacts survive and `package.json` is retained → `strip-manifest.json`), builds a
**derived image** (pinned slim + git; build-time network only, no new base pull), runs **container
C with `--network none`**, and produces TWO positive proofs:
- `blocked-egress.log` — from inside C, `git clone` the repo AND `npm install`/`npm view` the
  package both **blocked** (network axis);
- `blindness-proof.json` + `fs-blindness.log` — `assert-blindness.mjs` drives the **real** cook
  tool-guard with crafted events and proves every route to the oracle is **denied** (Read of an
  oracle test file / the manifest / a `..` or symlink escape; Glob/Grep enumeration of tests) while
  legitimate in-workspace study is **allowed**, plus that the workspace holds **zero** oracle
  artifacts (filesystem axis). The build **aborts** if any case fails.

C is left running so the cook can `docker exec` into it.

**`capture-run-cook.sh`** runs the **author-creator cook** = a headless `claude -p` on the host
(inference via host OAuth) under a deny-by-default PreToolUse hook
(`cook-tool-guard.mjs`, matcher `*` so it fires on **every** tool — the prior bug was a Bash-only
matcher that let Read/Glob/Grep reach the oracle):
- **file tools** (Read/Glob/Grep) are confined to the stripped workspace (resolves absolute/`..`/
  symlink paths; denies escapes);
- **Bash** is confined to `docker exec <net-off C>` (deny host shell / container-escape verbs);
- WebFetch/WebSearch/Agent/Task/Write/Edit are withheld at launch.

The cook runs with `cwd = the stripped workspace`, studies it, runs the **seed-create** skill,
answers the **fixed interview contract** (recorded to `interview-contract.md`, derived only from
non-oracle materials), and **stops at `SEEDCREATE_RESULT=DRAFT`** (no harden loop). The seed
(SEED.md + README.md) is written to `runs/run-<id>/seed/` via `docker exec` into `/seed` and
git-init'd by the harness. The hook is scoped to the cook's `--settings` only — it does NOT affect
the harness shell (the harness still clones/builds normally; this scoping is itself the scope proof).

**Guard hardening (review cycle 2 — after adversarial review).** `cook-tool-guard.mjs` is
deny-by-default and airtight against the bypasses an earlier prefix-only version allowed:
- **Bash** must be EXACTLY one `docker exec <the run's net-off container> …`; any host-level shell
  metacharacter (`; | & < > ( ) $` backtick, newline) OUTSIDE single quotes is rejected, so
  `… ; curl`, `… < hostfile`, `"$(…)"`, and pipes-to-host are all blocked. Pipes/`&&` INSIDE the
  single-quoted `sh -lc '…'` script (which runs in the container) are fine.
- **Glob/Grep** resolve EVERY path-bearing param (`path`, Glob `pattern`, Grep `glob`) and validate
  under **brace + char-class expansion**: any branch resolving via `..`, absolute, `{../x,…}`, or
  `[.][.]/` to outside the workspace is denied — not just literal/absolute prefixes.
- **deny-by-default tool allow-list**: unknown / aliased / case-variant tools (`read`, `MultiEdit`)
  are denied; only file tools (workspace-confined), Bash (docker-exec-only), and
  Skill/TodoWrite/Task*/ToolSearch pass.
- The cook authors the seed with the **Write tool** (hook-confined to the workspace, into
  `seed-output/`) — heredoc-via-`docker exec` is intentionally impossible under the metachar rule.
- **Seed symlink refusal:** the host REFUSES any symlink anywhere in the seed (`find -type l` →
  abort) and copies without dereferencing — a cook cannot `ln -s` the oracle into its output and have
  the host resolve it. Seed validation requires BOTH `SEED.md` and `README.md`.
- **Prior-knowledge redaction (scoped claim):** what is withheld = test BODIES, test-file
  ENUMERATION, and COUNTS/coverage goals — redacted by `strip-oracle.mjs` from retained PROSE docs
  (`CLAUDE.md`/`README*`), enforced by `assert-stripped.mjs`. What is RETAINED as capability context
  = `package.json` and `biome.json` (deps/bin/scripts/format config), even though they reference a
  test runner — *a runner existing is not the oracle*.
- **No silent accept:** `capture-run-cook.sh` aborts loudly on non-zero cook exit, a missing
  `SEEDCREATE_RESULT=DRAFT` in the cook's final result, an empty seed, a seed symlink, or a failed
  copy/commit.

The former bypass vectors (host-chain, stdin redirect, `$()`, pipe-to-host, relative/brace/char-class
glob escapes, aliased tools, seed symlinks) are regression-covered in the proof suites (a green proof
MEANS they are blocked).

Run-record outputs (under `runs/run-<id>/`): `capture-workspace/` (stripped + redacted),
`strip-manifest.json` (incl. `oracleMetadataLeaks: []`), `blocked-egress.log`, `blindness-proof.json`,
`fs-blindness.log`, `interview-contract.md`, `seed/`, `cook-transcript.jsonl`, `cook-readable.md`,
`cook-tool-log.txt`.

## Scope boundary
Chunk 1 produces the config + loader. Chunk 2 proves the pin builds and establishes the green
count. Chunk 3 captures the seed under network-off blindness. Chunks 4–5 (rebuild / score) and
Chunk 6 (end-to-end run record) follow.
