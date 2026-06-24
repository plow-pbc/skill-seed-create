#!/usr/bin/env bash
# Chunk 6 — end-to-end eval loop (the last chunk). ONE command runs the full loop on
# the target under a SINGLE CANONICAL run-id and produces a complete, auditable
# runs/run-<id>/ : seed + container/egress logs + BOTH cook transcripts/tool logs +
# baseline.json + fidelity.json + summary.md.
#
# Stages run SEQUENTIALLY; each stage's HEAVY intermediates (node_modules, vendored
# deps, containers) are cleaned BEFORE the next, so peak disk ≈ one stage (~200 MB).
# Fail-clearly: any stage's loud abort propagates (set -e). Baseline not green → abort.
#
# Reuses ALL established machinery: baseline.sh, capture-build-c.sh, capture-run-cook.sh,
# capture-build-r.sh, capture-run-rebuild.sh, scorer.sh (which reuse the loader, the
# shared guard, safe-collect, strict-green, cross-checks). No new pulls (pinned images).
#
# Usage: run-eval.sh [target] [run-id]
set -euo pipefail
LIB_TAG=eval
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd git docker node claude npm

TARGET="${1:-oh-my-logo}"
RUN_ID="${2:-e-$(date -u +%Y%m%d-%H%M%S)}"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
H="$EVAL_DIR/harness"
START=$(date +%s)

mkdir -p "$RUN_DIR"
log "================ eval loop ================"
log "target=$TARGET   CANONICAL run-id=$RUN_ID"
log "run dir (single record for ALL stages): $RUN_DIR"
df -h /System/Volumes/Data 2>/dev/null | tail -1 | sed 's/^/[eval] df: /' || true

# ---- STAGE 1/4: baseline (oracle ground truth; abort if not green) ----------
log "---- STAGE 1/4: baseline ----"
bash "$H/baseline.sh" "$TARGET" "$RUN_ID"          # -> $RUN_DIR/baseline.json (aborts if not green)
saferm "$RUN_DIR/workspace" "$RUN_DIR" || true     # drop the baseline clone+node_modules (heavy)
log "baseline done; clone+node_modules cleaned."

# ---- STAGE 2/4: capture (net-off C + author-creator cook -> seed) -----------
log "---- STAGE 2/4: capture (network-off, three-axis blind) ----"
bash "$H/capture-build-c.sh" "$TARGET" "$RUN_ID"   # builds image (reused later), container C, proofs
bash "$H/capture-run-cook.sh" "$RUN_ID" "$TARGET"  # author-creator cook -> $RUN_DIR/seed
docker rm -f "$(cat "$RUN_DIR/capture-c.name" 2>/dev/null)" >/dev/null 2>&1 || true  # clean container C
log "capture done; container C removed. seed at $RUN_DIR/seed."

# ---- STAGE 3/4: rebuild (vendored deps + net-off R + rebuild cook) ----------
log "---- STAGE 3/4: rebuild (vendored deps, fully net-off) ----"
bash "$H/capture-build-r.sh" "$RUN_DIR/seed" "$RUN_ID" "$TARGET"  # vendor + R + proofs
bash "$H/capture-run-rebuild.sh" "$RUN_ID" "$TARGET"             # rebuild cook -> $RUN_DIR/rebuilt
docker rm -f "$(cat "$RUN_DIR/rebuild-r.name" 2>/dev/null)" >/dev/null 2>&1 || true
saferm "$RUN_DIR/rebuild-workspace/node_modules" "$RUN_DIR" || true  # heavy (~124 MB)
saferm "$RUN_DIR/vendor/node_modules" "$RUN_DIR" || true            # (moved already; belt+suspenders)
log "rebuild done; container R removed, vendored node_modules cleaned. artifact at $RUN_DIR/rebuilt."

# ---- STAGE 4/4: score (held-out oracle vs rebuilt -> classified fidelity) ---
log "---- STAGE 4/4: score (classified fidelity) ----"
bash "$H/scorer.sh" "$RUN_DIR" "$TARGET" "$RUN_ID"  # -> $RUN_DIR/fidelity.json
# preserve the vitest reports, then drop the heavy scorer workspace (clone+node_modules)
cp "$RUN_DIR/scorer-workspace/reference-report.json" "$RUN_DIR/" 2>/dev/null || true
cp "$RUN_DIR/scorer-workspace/fidelity-report.json" "$RUN_DIR/" 2>/dev/null || true
saferm "$RUN_DIR/scorer-workspace" "$RUN_DIR" || true
log "score done; scorer workspace cleaned."

# ---- summary + record assembly --------------------------------------------
END=$(date +%s); WALL=$((END - START))
log "---- assembling summary.md ----"
node "$H/emit-summary.mjs" "$TARGET" "$RUN_DIR" "$WALL" > /dev/null

echo
echo "================ RUN RECORD: $RUN_DIR ================"
( cd "$RUN_DIR" && find . -maxdepth 2 -not -path '*/.git/*' | sort )
echo "================ summary.md ================"
cat "$RUN_DIR/summary.md"
log "eval loop COMPLETE in ${WALL}s. canonical record: $RUN_DIR"
df -h /System/Volumes/Data 2>/dev/null | tail -1 | sed 's/^/[eval] df: /' || true
