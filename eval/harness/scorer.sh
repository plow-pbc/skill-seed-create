#!/usr/bin/env bash
# Chunk 5 — classified scorer (codified). Runs the held-out ORACLE against the
# REBUILT artifact and emits fidelity.json = X/N + each failure tagged by class.
#
# The scorer is ALLOWED to touch the oracle (it does not feed the seed). It binds
# the ORIGINAL, UNMODIFIED oracle tests to the REBUILT module surface by swapping
# ONLY `src/` (moduleSurface mountPoint) — the tests still `import ../src/*.js`,
# now resolving to the rebuild.
#
# Two vitest runs in ONE container (network on, for npm ci @ pinned lockfile):
#   Run A (reference): ORIGINAL src — must be N/N green; gives per-file denominators
#                      + validates the oracle env (a non-green ref indicts the harness).
#   Run B (fidelity):  REBUILT src bound at src/ — X/N; failures classified.
#
# Pipeline: clone@SHA (host) -> --verify gate (8 files) -> container: npm ci ->
#           vitest(json) Run A -> swap src=rebuilt -> vitest(json) Run B ->
#           emit-fidelity.mjs (classify).
#
# Usage: scorer.sh <rebuild-run-dir> [target] [score-run-id]
set -euo pipefail
LIB_TAG=scorer
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd git docker node

REBUILD_DIR="${1:?usage: scorer.sh <rebuild-run-dir> [target] [score-run-id]}"
[ -d "$REBUILD_DIR" ] || { echo "[scorer] ABORT: rebuild-run-dir not found: $REBUILD_DIR" >&2; exit 1; }
REBUILD_DIR=$(cd "$REBUILD_DIR" && pwd)   # absolutize (docker -v needs an absolute host path)
TARGET="${2:-oh-my-logo}"
RUN_ID="${3:-s-$(date -u +%Y%m%d-%H%M%S)}"
CONFIG="$EVAL_DIR/targets/$TARGET/config.json"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/scorer-workspace"
REBUILT_SRC="$REBUILD_DIR/rebuilt/src"

[ -f "$CONFIG" ] || abort "no config at $CONFIG"
[ -d "$REBUILT_SRC" ] || abort "no rebuilt src at $REBUILT_SRC (run capture-run-rebuild.sh first)"

REPO=$(cfg "$CONFIG" source.repoUrl)
SHA=$(cfg "$CONFIG" source.sha)
BASE=$(cfg "$CONFIG" baseImage)
INSTALL=$(cfg "$CONFIG" commands.install)
MOUNT_POINT=$(cfg "$CONFIG" moduleSurface.mountPoint); MOUNT_POINT="${MOUNT_POINT:-src}"
TESTCMD=$(cfg "$CONFIG" oracle.testCommand)

mkdir -p "$RUN_DIR"
saferm "$WORKSPACE" "$RUN_DIR" || true
log "target=$TARGET score-run=$RUN_ID rebuild=$REBUILD_DIR base=$BASE"

# ---- 1. clone @ pinned SHA on host (the ORACLE bundle source) --------------
log "cloning oracle @ $SHA on host ..."
git clone --quiet "$REPO" "$WORKSPACE" 2>&1 | tee "$RUN_DIR/scorer-clone.log" || abort "git clone failed"
git -C "$WORKSPACE" checkout --quiet "$SHA" 2>&1 | tee -a "$RUN_DIR/scorer-clone.log" || abort "checkout $SHA failed"
[ "$(git -C "$WORKSPACE" rev-parse HEAD)" = "$SHA" ] || abort "workspace HEAD != $SHA"

# ---- 2. --verify gate: oracle layout matches the manifest (8 files) --------
log "running --verify gate (oracle layout vs manifest @ SHA) ..."
node "$EVAL_DIR/harness/load-config.mjs" "$TARGET" --verify "$WORKSPACE" 2>&1 | tee "$RUN_DIR/scorer-verify.log" \
  || abort "--verify gate failed — oracle layout diverges from manifest. See scorer-verify.log"

# snapshot the ORIGINAL module surface (to prove the swap actually happened)
( cd "$WORKSPACE" && find "$MOUNT_POINT" -type f | sort ) > "$RUN_DIR/original-src-filelist.txt"

# ---- 3. container: npm ci -> Run A (original) -> swap -> Run B (rebuilt) ----
# Mount the rebuilt src read-only at /rebuilt-src; bind it in by swapping src/.
log "scorer container ($BASE): npm ci -> vitest Run A (original) -> bind rebuilt -> vitest Run B ..."
set +e
docker run --rm \
  --network bridge \
  -v "$WORKSPACE:/work" \
  -v "$REBUILT_SRC:/rebuilt-src:ro" \
  -w /work \
  "$BASE" \
  sh -c "set -e
    echo '=== node/npm ==='; node --version; npm --version
    echo '=== install (lockfile): $INSTALL ==='; $INSTALL
    echo '=== Run A (reference): ORIGINAL src ==='
    $TESTCMD --reporter=default --reporter=json --outputFile=/work/reference-report.json || true
    echo '=== BIND: swap src/ <- REBUILT module surface ==='
    rm -rf '/work/$MOUNT_POINT'
    mkdir -p '/work/$MOUNT_POINT'
    cp -R /rebuilt-src/. '/work/$MOUNT_POINT/'
    echo '--- bound src/ now contains: ---'; find '/work/$MOUNT_POINT' -type f | sort
    echo '=== Run B (fidelity): REBUILT src ==='
    $TESTCMD --reporter=default --reporter=json --outputFile=/work/fidelity-report.json || true
  " 2>&1 | tee "$RUN_DIR/scorer-container.log"
CONTAINER_RC=${PIPESTATUS[0]}
set -e
log "scorer container exit: $CONTAINER_RC (vitest non-zero on Run B failures is expected)"

# snapshot the BOUND surface (post-swap) — proof the rebuild was bound, not the original
( cd "$WORKSPACE" && find "$MOUNT_POINT" -type f | sort ) > "$RUN_DIR/bound-src-filelist.txt"

# ---- 4. classify + emit fidelity.json -------------------------------------
log "emitting fidelity.json (classify each failure) ..."
node "$EVAL_DIR/harness/emit-fidelity.mjs" \
  "$TARGET" "$RUN_DIR" "$WORKSPACE" "$REBUILD_DIR" || abort "emit-fidelity failed (harness fault)"

log "scorer done. fidelity.json + reports under $RUN_DIR"
