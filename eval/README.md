# seed-create eval harness

Measures **fidelity**: run `seed-create` on real software, rebuild that software from the
resulting seed in a network-isolated clean room, and score the rebuild against the original's
own (held-out) test suite. See `../docs/superpowers/specs/2026-06-23-seed-create-eval-harness-design.md`.

## Layout
```
eval/
  harness/                 # codified mechanical scripts
    load-config.mjs        # Chunk 1: load/validate a target config; --verify expands oracle globs
  targets/
    oh-my-logo/
      config.json          # source pin (repo+SHA), base image, build/test cmds, devDeps,
                           # and the ORACLE MANIFEST (globs for tests/fixtures/snapshots/config)
  runs/
    run-<id>/              # the ONLY output location (created per run by later chunks)
```

## The oracle manifest is one inventory
`config.json#oracle` defines, by glob, every held-out test artifact. The SAME inventory drives
BOTH capture-withhold (Chunk 3 strips these globs) AND scorer-run (Chunk 5 runs these tests).
Never key isolation on "the test dir."

## Loader (Chunk 1)
```bash
node harness/load-config.mjs oh-my-logo                 # validated summary
node harness/load-config.mjs oh-my-logo --json          # validated config as JSON
node harness/load-config.mjs oh-my-logo --verify <dir>  # expand oracle globs against a checkout
```
`--verify` is how the manifest's globs are confirmed against the real file layout at the pinned
SHA: `git clone` the repo, `git checkout <sha>`, then point `--verify` at it. It exits non-zero
unless the expanded globs equal the manifest's expected file list (no missing, no extra).

## Scope boundary
Chunk 1 produces the config + loader and confirms the globs match the layout. It does **not**
prove the pin builds or establish the green test count — that is Chunk 2's baseline.
