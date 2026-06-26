# The `macos-vm` runner (Chunk 5)

The second environment fork from the v3 design (§8). The docker lane co-locates the agent
and the software in one Linux container (`docker exec`); the **macos-vm lane runs the agent
ON THE HOST (neo) and drives a headless macOS GUEST over SSH** (`ssh-to-guest`): push source
in, build + run the oracle in the guest, pull evidence out. Network-on **plain NAT**, using
the `gui-ready-audio` golden. **Serial** (~1 VM on 8 GB) — materially slower; named, not hidden.

`dispatch.mjs` selects this runner when `environment.type == "macos-vm"` (now `implemented:true`,
`setup: setup-macos.sh`). It reuses the SHARED pure scorers by **calling** them (never editing):
`code-copy.mjs`, `visual-terminal.mjs`, `egress-proxy.mjs`, `leakage-audit.mjs`,
`harness/strip-seed-source.mjs`. our-criteria runs in the guest via the new `criteria-check-guest.mjs`.

## Files (all NEW; the docker lane is untouched)

```
framework/
  lib-macos.sh            # host-side guest driver: plain-NAT launch (NOT neo-vm run/softnet),
                          #   keychain-unlock-in-session, clone/boot/wait-ssh/exec/push/pull/
                          #   capture/strip-oracle/gateway/delete
  setup-macos.sh          # Setup: build original + assert oracle GREEN + capture reference IN
                          #   A GUEST; strip baked oracle; verify guest clean of oracle/
  run-macos.sh            # end-to-end: Setup → Creator(host) → Installer(guest) → Evaluator,
                          #   N× serial, egress + leakage on this lane → runs/<id>/ (§5) + index.json
  stage-agent-macos.sh     # one agent stage: creator (host, file-tools-only) | installer (guest build)
  guest-build.sh          # the Installer's ONLY shell: sync ws→guest, run in guest (proxied), sync back
  agent-guard-guest.mjs    # PreToolUse confinement: file tools → ws; Bash → the guest-build seam (or denied)
  criteria-check-guest.mjs# our-criteria scorer, GUEST lane (runs the built binary over SSH)
  evaluate-macos.sh       # Evaluator: build+run install in guest vs hidden oracle → score/ (§5)
  verify-image-clean.sh   # asserts the guest holds no oracle/ (any baked oracle kit stripped; eval oracle absent)
evals/trivial-macos/      # the trivial proof target (a tiny Swift `greet` CLI + criteria)
```

## Run it (on neo)

```bash
# on neo, with the eval tree + the seed-create repo synced over:
export NEO_VM_ENGINE=tart NEO_GUEST_USER=admin
framework/run-macos.sh trivial-macos --runs 1 --skill-repo ~/eval-macos/skill-seed-create
```

Produces, per run, the full §5 folder:
`runs/<id>/{run.json, seed/, rebuild/, transcripts/{capture,rebuild}.jsonl, egress.log,
egress-proof.log, score/{scorecard.json, evidence/, leakage-audit.json, image-clean.json},
run-summary.md}` + `runs/index.json`.

## Blindness, egress, image-clean (this lane's Done-when)

- **Creator** runs on the host **file-tools-only** (Bash disabled by the guard) so it has no
  host shell and cannot read the oracle; it sees the full `source/` copy and writes the seed.
- **Installer** gets the seed alone (`strip-seed-source` re-strips any bundled source) and builds
  **in a fresh guest** whose egress is routed through the host **egress proxy** over plain NAT
  (`HTTPS_PROXY`/git `http.proxy` → the vmnet gateway). The **denylist** 403s the target host /
  404s the target package while allowing deps.
- **Egress is captured every run** (`egress.log`) and an explicit **egress proof**
  (`egress-proof.log`) drives the guest through the proxy to a benign host (**ALLOW**, logged) and
  the target host (**DENY**, logged) — proving capture + denylist over plain NAT independent of
  whether the zero-dep Swift build fetched anything.
- **Leakage audit** (shared `leakage-audit.mjs`) runs post-hoc over `egress.log` + `rebuild.jsonl`;
  an INVALIDATED run is discarded and re-run.
- **Image-clean**: a golden image may BAKE an oracle kit under the guest HOME (a scoring artifact). The runner
  **strips** it from every clone and **verifies** (a) it is gone and (b) THIS eval's `oracle/` was
  never materialized in-guest — the oracle is read only by the Evaluator on the host.

> Launch detail: eval VMs boot with **plain NAT + nohup + caffeinate** (not `neo-vm run`, which
> uses `--net-softnet` → `tart ip` returns nothing and dies with the SSH session). Keychain is
> unlocked in-session before each launch (macOS 15+).
