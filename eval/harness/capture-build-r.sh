#!/usr/bin/env bash
# Chunk 4 (part 1) — build the clean-room rebuild container R.
#
# Vendored-deps blindness (head-chef decision): a net-ON prep resolves the target's
# deps from its PINNED lockfile into a node_modules that EXCLUDES the target (it's the
# lockfile root), then R runs FULLY net-off holding ONLY the source-stripped seed +
# the vendored deps. Allowlist-by-construction: the target simply isn't present.
#
# Pipeline: copy seed -> source-STRIP (Option 1) -> vendor deps (net on) -> assemble
#           rebuild-workspace (stripped seed + node_modules) -> run R (--network none)
#           -> PROVE: (a) egress to target BLOCKED + deps available offline,
#                     (b) vendor listing target ABSENT,
#                     (c) rebuild-cook blindness (oracle denied, net-off) via the
#                         FIXED cook-tool-guard.
# Leaves R RUNNING for capture-run-rebuild.sh.
#
# Usage: capture-build-r.sh <seed-path> [run-id] [target]
set -euo pipefail
LIB_TAG=rebuild-build
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd git docker node npm

SEED_SRC="${1:?usage: capture-build-r.sh <seed-path> [run-id] [target]}"
RUN_ID="${2:-r-$(date -u +%Y%m%d-%H%M%S)}"
TARGET="${3:-oh-my-logo}"
CONFIG="$EVAL_DIR/targets/$TARGET/config.json"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/rebuild-workspace"     # mounted into R as /rebuild (rw)
IMAGE="eval-capture-c:${TARGET}"           # reuse the pinned node-slim+git image (no new pull)
CONTAINER="rebuild-r-${RUN_ID}"
EGRESS_LOG="$RUN_DIR/rebuild-egress.log"

[ -f "$CONFIG" ] || abort "no config at $CONFIG"
[ -d "$SEED_SRC" ] || abort "seed path not found: $SEED_SRC"
[ -f "$SEED_SRC/SEED.md" ] || abort "seed at $SEED_SRC has no SEED.md — not a seed repo"
docker image inspect "$IMAGE" >/dev/null 2>&1 || abort "image $IMAGE missing — run a capture build first (no new pulls)"

REPO=$(cfg "$CONFIG" source.repoUrl)
mkdir -p "$RUN_DIR"
saferm "$WORKSPACE" "$RUN_DIR" || true
mkdir -p "$WORKSPACE"
log "target=$TARGET run=$RUN_ID seed=$SEED_SRC"

# ---- 1. copy the seed in, then SOURCE-STRIP (Option 1) --------------------
log "copying seed -> rebuild workspace, then source-stripping (R gets description-only) ..."
[ -d "$SEED_SRC/.git" ] && log "note: input seed has a .git — host strips ALL git state before R sees it."
cp -R "$SEED_SRC/." "$WORKSPACE/"
# HOST CONTROLS GIT (final-pass IMPORTANT): never let any (cook-created) git state
# reach R — strip every .git recursively, R rebuilds from prose only.
find "$WORKSPACE" -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true
node "$EVAL_DIR/harness/strip-seed-source.mjs" "$WORKSPACE" "$RUN_DIR" 2>&1 | tee "$RUN_DIR/seed-strip.log" \
  || abort "seed source-strip failed — see seed-strip.log"

# ---- 2. vendored deps (net ON), target excluded by construction -----------
"$EVAL_DIR/harness/vendor-deps.sh" "$TARGET" "$RUN_ID"   # writes $RUN_DIR/vendor/node_modules + listing
[ -d "$RUN_DIR/vendor/node_modules" ] || abort "vendoring produced no node_modules"
# move the vendored node_modules into the rebuild workspace (single writable copy);
# the canonical listing stays in vendor/ for the audit record.
mv "$RUN_DIR/vendor/node_modules" "$WORKSPACE/node_modules"
[ -e "$WORKSPACE/node_modules/$TARGET" ] && abort "VENDOR BREACH: $TARGET present in workspace node_modules"

# ---- 3. run R, FULLY network OFF ------------------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "starting container R ($CONTAINER) --network none (mount: /rebuild = stripped seed + vendored deps) ..."
docker run -d --name "$CONTAINER" \
  --network none \
  -v "$WORKSPACE:/rebuild" \
  -w /rebuild \
  "$IMAGE" sleep infinity > "$RUN_DIR/container-r.id"
echo "$CONTAINER" > "$RUN_DIR/rebuild-r.name"
log "container R id: $(cut -c1-12 < "$RUN_DIR/container-r.id")"

# ---- 4. POSITIVE proof: target unreachable + deps available offline -------
log "running rebuild-egress proof (target blocked; deps resolve offline) ..."
{
  echo "===== rebuild-egress proof for $CONTAINER ($IMAGE, --network none) ====="
  echo "target repo: $REPO"
  echo
  echo "--- net interfaces inside R (expect loopback only) ---"
  docker exec "$CONTAINER" sh -lc 'ip -o addr show 2>/dev/null || cat /proc/net/dev'
  echo
  echo "--- [path 1] git clone the target (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -lc "git clone --depth 1 '$REPO' /tmp/leak 2>&1"; then
    echo "RESULT: path1 SUCCEEDED — BLINDNESS BREACH"; else echo "RESULT: path1 BLOCKED (exit $?)"; fi
  echo
  echo "--- [path 2] npm install the target package (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -lc "cd /tmp && npm install $TARGET 2>&1"; then
    echo "RESULT: path2 SUCCEEDED — BLINDNESS BREACH"; else echo "RESULT: path2 BLOCKED (exit $?)"; fi
  echo
  echo "--- [path 3] npm view the target (registry) (expect: BLOCKED) ---"
  if docker exec "$CONTAINER" sh -lc "npm view $TARGET version 2>&1"; then
    echo "RESULT: path3 SUCCEEDED — BLINDNESS BREACH"; else echo "RESULT: path3 BLOCKED (exit $?)"; fi
  echo
  echo "--- [deps] vendored deps resolve OFFLINE (expect: OK) ---"
  if docker exec "$CONTAINER" sh -lc 'cd /rebuild && node -e "require(\"typescript\");require(\"figlet\");console.log(\"deps-offline-OK\")" 2>&1'; then
    echo "RESULT: deps available offline (OK)"; else echo "RESULT: deps MISSING offline (exit $?) — vendor incomplete"; fi
} 2>&1 | tee "$EGRESS_LOG"

if grep -q "BLINDNESS BREACH" "$EGRESS_LOG"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  abort "rebuild-egress proof FAILED — target reachable from R. See $EGRESS_LOG"
fi
if ! grep -q "deps available offline (OK)" "$EGRESS_LOG"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  abort "vendored deps did not resolve offline — R cannot build. See $EGRESS_LOG"
fi

# ---- 5. rebuild-cook blindness proof (FIXED cook-tool-guard) ---------------
log "running rebuild blindness proof (oracle-naive + net-off + vendor/seed state) ..."
COOK_ALLOW_READ="$(skill_install_root seed-install)" \
node "$EVAL_DIR/harness/assert-rebuild-blindness.mjs" "$TARGET" "$WORKSPACE" "$CONTAINER" "$RUN_DIR" \
  || { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; \
       abort "rebuild blindness proof FAILED — see $RUN_DIR/rebuild-blindness.log"; }

log "container R READY + ALL proofs PASSED (egress target-blocked, vendor target-absent, blindness)."
log "  egress log:        $EGRESS_LOG"
log "  vendor listing:    $RUN_DIR/vendor/vendor-listing.txt"
log "  blindness proof:   $RUN_DIR/rebuild-blindness.log"
log "  seed-as-received:  $RUN_DIR/seed-as-received.json"
log "container=$CONTAINER  workspace=$WORKSPACE"
