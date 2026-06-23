#!/usr/bin/env bash
# Chunk 2 — baseline harness (codified).
#
# Stands the target up in container O AT THE PINNED SHA, builds it, runs the oracle
# suite, and emits runs/run-<id>/baseline.json with the REAL green count established
# at the pin. Aborts LOUDLY (non-zero) if the suite is not fully green or the
# manifest diverges — a non-green oracle is invalid, no fallbacks.
#
# Pipeline: clone@SHA (host; slim base omits git) → `--verify` gate (Chunk 1) →
#           container O: `npm ci` (lockfile) → build → vitest → emit-baseline.mjs.
#
# Usage: harness/baseline.sh [target] [run-id]
set -euo pipefail

EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TARGET="${1:-oh-my-logo}"
RUN_ID="${2:-$(date -u +%Y%m%d-%H%M%S)}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CONFIG="$EVAL_DIR/targets/$TARGET/config.json"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/workspace"

log()   { echo "[baseline] $*"; }
abort() { echo "" >&2; echo "[baseline] ABORT: $*" >&2; echo "" >&2; exit 1; }

[ -f "$CONFIG" ] || abort "no config at $CONFIG (run from a checkout with targets/$TARGET/config.json)"

cfg() {
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v[k];process.stdout.write(String(v))' \
    "$CONFIG" "$1"
}
REPO=$(cfg source.repoUrl)
SHA=$(cfg source.sha)
BASE=$(cfg baseImage)
INSTALL=$(cfg commands.install)
BUILD=$(cfg commands.build)
TESTCMD=$(cfg oracle.testCommand)

mkdir -p "$RUN_DIR"
rm -rf "$WORKSPACE"
log "target=$TARGET run=$RUN_ID"
log "repo=$REPO sha=$SHA base=$BASE"
log "run dir: $RUN_DIR"

# ---- 1. clone @ pinned SHA (on host: node:20-slim omits git) --------------
log "cloning @ pinned SHA on host ..."
git clone --quiet "$REPO" "$WORKSPACE" 2>&1 | tee "$RUN_DIR/clone.log" || abort "git clone failed"
git -C "$WORKSPACE" checkout --quiet "$SHA" 2>&1 | tee -a "$RUN_DIR/clone.log" || abort "git checkout $SHA failed"
HEAD=$(git -C "$WORKSPACE" rev-parse HEAD)
[ "$HEAD" = "$SHA" ] || abort "workspace HEAD ($HEAD) != pinned SHA ($SHA)"
log "checked out $HEAD"

# ---- 2. precondition gate: --verify (anchor + globs + completeness) --------
log "running --verify gate (manifest vs real layout @ SHA) ..."
if ! node "$EVAL_DIR/harness/load-config.mjs" "$TARGET" --verify "$WORKSPACE" 2>&1 | tee "$RUN_DIR/verify.log"; then
  abort "--verify gate failed — manifest rot / wrong SHA. Not building. See verify.log"
fi

# ---- 3. container O: npm ci (lockfile) → build → vitest (json report) ------
log "container O: $BASE — npm ci -> build -> vitest ..."
set +e
docker run --rm \
  --network bridge \
  -v "$WORKSPACE:/work" \
  -w /work \
  "$BASE" \
  sh -c "set -e
    echo '=== node/npm versions ==='; node --version; npm --version
    echo '=== install (lockfile): $INSTALL ==='; $INSTALL
    echo '=== build: $BUILD ==='; $BUILD
    echo '=== test: $TESTCMD ==='; $TESTCMD --reporter=default --reporter=json --outputFile=/work/vitest-report.json
  " 2>&1 | tee "$RUN_DIR/container.log"
CONTAINER_RC=${PIPESTATUS[0]}
set -e
log "container exit code: $CONTAINER_RC"

# ---- 4. parse + manifest cross-check + emit baseline.json -----------------
log "emitting baseline.json (parse + manifest cross-check) ..."
set +e
node "$EVAL_DIR/harness/emit-baseline.mjs" \
  "$TARGET" "$RUN_DIR" "$WORKSPACE" "/work" "$CONTAINER_RC" "$RUN_ID" "$TIMESTAMP"
EMIT_RC=$?
set -e

if [ "$EMIT_RC" -ne 0 ]; then
  # PROPAGATE emit-baseline.mjs's exact failure class (2 not_green / 3 manifest
  # divergence / 4 no-report) — do NOT collapse to 1. Chunk 6 keys on these.
  echo "" >&2
  echo "[baseline] ABORT (exit $EMIT_RC): baseline not green / manifest divergence / no report." >&2
  echo "[baseline] baseline.json records the failure. See logs in $RUN_DIR." >&2
  echo "" >&2
  exit "$EMIT_RC"
fi

log "BASELINE GREEN. record: $RUN_DIR/baseline.json"
