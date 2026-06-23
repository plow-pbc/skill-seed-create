#!/usr/bin/env bash
# Chunk 3 (part 1) — build container C: stripped workspace + network OFF + positive
# blocked-egress proof. This is the top-invariant gate; the proof is the artifact.
#
# Pipeline: clone@SHA (host) -> manifest-driven oracle strip -> assert-stripped ->
#           build derived image (pinned slim + git, build-time net only) ->
#           run capture-C with --network none -> PROVE both target-recovery paths
#           (git clone + npm install/view) are BLOCKED from inside C.
#
# Leaves capture-C RUNNING (sleep infinity) so the author-creator cook can
# `docker exec` into it. Emits under runs/run-<id>/: capture-workspace/,
# strip-manifest.json, blocked-egress.log, capture-c.image, container-c.id.
#
# Usage: capture-build-c.sh [target] [run-id]
set -euo pipefail
LIB_TAG=capture
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"

TARGET="${1:-oh-my-logo}"
RUN_ID="${2:-$(date -u +%Y%m%d-%H%M%S)}"
CONFIG="$EVAL_DIR/targets/$TARGET/config.json"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/capture-workspace"
IMAGE="eval-capture-c:${TARGET}"
CONTAINER="capture-c-${RUN_ID}"
EGRESS_LOG="$RUN_DIR/blocked-egress.log"

require_cmd git docker node
[ -f "$CONFIG" ] || abort "no config at $CONFIG"

REPO=$(cfg "$CONFIG" source.repoUrl)
SHA=$(cfg "$CONFIG" source.sha)
BASE=$(cfg "$CONFIG" baseImage)

mkdir -p "$RUN_DIR"
saferm "$WORKSPACE" "$RUN_DIR" || true
log "target=$TARGET run=$RUN_ID base=$BASE"

# ---- 1. clone @ pinned SHA on host ----------------------------------------
log "cloning @ $SHA on host ..."
git clone --quiet "$REPO" "$WORKSPACE" 2>&1 | tee "$RUN_DIR/capture-clone.log" || abort "git clone failed"
git -C "$WORKSPACE" checkout --quiet "$SHA" 2>&1 | tee -a "$RUN_DIR/capture-clone.log" || abort "checkout $SHA failed"
[ "$(git -C "$WORKSPACE" rev-parse HEAD)" = "$SHA" ] || abort "workspace HEAD != $SHA"
# Drop the .git dir so C is a plain working copy (no history that could leak the oracle).
saferm "$WORKSPACE/.git" "$WORKSPACE" || true

# ---- 2. manifest-driven oracle strip --------------------------------------
log "stripping oracle artifacts (manifest globs + lockfile) ..."
node "$EVAL_DIR/harness/strip-oracle.mjs" "$TARGET" "$WORKSPACE" 2>&1 | tee "$RUN_DIR/strip.log" || abort "strip failed"

# ---- 3. assert the strip (no oracle artifact survives; package.json stays) -
log "asserting stripped workspace ..."
node "$EVAL_DIR/harness/assert-stripped.mjs" "$TARGET" "$WORKSPACE" "$RUN_DIR" 2>&1 | tee -a "$RUN_DIR/strip.log" \
  || abort "strip assertion failed (oracle artifact survived) — see strip.log"

# ---- 4. build derived image (pinned slim + git); build-time network only ---
log "building derived image $IMAGE (FROM $BASE + git) ..."
BUILD_CTX="$RUN_DIR/.cimg"
saferm "$BUILD_CTX" "$RUN_DIR" || true
mkdir -p "$BUILD_CTX"
cat > "$BUILD_CTX/Dockerfile" <<EOF
# Reuses the PINNED base (no new base image pulled); adds git so C can (a) attempt
# the blocked git-clone egress test and (b) git-init the seed. apt only at build.
FROM $BASE
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
EOF
docker build -t "$IMAGE" "$BUILD_CTX" 2>&1 | tee "$RUN_DIR/capture-image-build.log" || abort "image build failed"
saferm "$BUILD_CTX" "$RUN_DIR" || true
docker image inspect "$IMAGE" --format '{{.Id}} {{.RepoTags}}' > "$RUN_DIR/capture-c.image"
log "image: $(cat "$RUN_DIR/capture-c.image")"

# ---- 5. run capture-C with NETWORK OFF ------------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Single bind mount: /work = the stripped workspace (rw, so the cook can build/test
# in it). The seed is NOT a second bind mount — that previously phantom-faulted
# (host backing dir removed at run-cook start -> ENOENT virtiofs mount). Instead the
# cook writes the seed into an in-container dir (/seedout) and the unconfined HOST
# docker-cp's it out after the cook exits (see capture-run-cook.sh). No second mount.
log "starting container C ($CONTAINER) with --network none (mount: /work stripped, rw) ..."
docker run -d --name "$CONTAINER" \
  --network none \
  -v "$WORKSPACE:/work" \
  -w /work \
  "$IMAGE" sleep infinity > "$RUN_DIR/container-c.id"
log "container C id: $(cut -c1-12 < "$RUN_DIR/container-c.id")"

# ---- 6. POSITIVE blocked-egress proof -------------------------------------
# Attempt BOTH spec-named target-recovery paths from inside net-none C and prove
# they are blocked. A non-zero exit / network error for each is the evidence.
log "running blocked-egress proof (git clone + npm) from inside C ..."
{
  echo "===== blocked-egress proof for $CONTAINER ($IMAGE, --network none) ====="
  echo "target repo: $REPO"
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "--- network interfaces inside C (expect loopback only) ---"
  docker exec "$CONTAINER" sh -c 'ip -o addr show 2>/dev/null || cat /proc/net/dev'
  echo
  echo "--- [path 1] git clone the target repo (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -c "git clone --depth 1 '$REPO' /tmp/leak1 2>&1"; then
    echo "RESULT: path1 SUCCEEDED — BLINDNESS BREACH"; P1=breach
  else
    echo "RESULT: path1 BLOCKED (git clone failed, exit $?)"; P1=blocked
  fi
  echo
  echo "--- [path 2] npm install the target package (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -c "cd /tmp && npm install oh-my-logo 2>&1"; then
    echo "RESULT: path2a SUCCEEDED — BLINDNESS BREACH"; P2a=breach
  else
    echo "RESULT: path2a BLOCKED (npm install failed, exit $?)"; P2a=blocked
  fi
  echo
  echo "--- [path 2b] npm view the target package (registry metadata) (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -c "npm view oh-my-logo version 2>&1"; then
    echo "RESULT: path2b SUCCEEDED — BLINDNESS BREACH"; P2b=breach
  else
    echo "RESULT: path2b BLOCKED (npm view failed, exit $?)"; P2b=blocked
  fi
  echo
  echo "--- summary ---"
  echo "path1(git clone)=$P1 path2a(npm install)=$P2a path2b(npm view)=$P2b"
} 2>&1 | tee "$EGRESS_LOG"

if grep -q "BLINDNESS BREACH" "$EGRESS_LOG"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  abort "blocked-egress proof FAILED — a target-recovery path succeeded. See $EGRESS_LOG"
fi
echo "$CONTAINER" > "$RUN_DIR/capture-c.name"

# ---- 7. POSITIVE filesystem-blindness proof (the inverse of the proven break) -
# Drive the REAL cook tool-guard with crafted events and prove the author-creator
# CANNOT Read/Glob/Grep any oracle artifact (host clones, the manifest, .. / symlink
# escapes) while in-workspace study stays allowed; and that the workspace itself
# holds zero oracle artifacts. Aborts the build if any confinement case fails.
log "running filesystem-blindness proof (cook tool-guard, positive demonstration) ..."
COOK_ALLOW_READ="$(skill_read_root)" \
node "$EVAL_DIR/harness/assert-blindness.mjs" "$TARGET" "$WORKSPACE" "$CONTAINER" "$RUN_DIR" \
  || { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; \
       abort "filesystem-blindness proof FAILED — see $RUN_DIR/fs-blindness.log"; }

log "container C READY + ALL confinement axes PROVEN (network egress + filesystem)."
log "  egress log:     $EGRESS_LOG"
log "  blindness proof: $RUN_DIR/fs-blindness.log  (+ blindness-proof.json)"
log "  strip manifest:  $RUN_DIR/strip-manifest.json"
log "container=$CONTAINER  workspace=$WORKSPACE"
