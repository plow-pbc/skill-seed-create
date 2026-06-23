#!/usr/bin/env bash
# Chunk 4 (prep) — vendored dependencies for the blind rebuild (net ON, host).
#
# Head-chef decision (brief-chunk4-design): PRE-SEEDED VENDORED DEPS, not a proxy.
# Resolve the target's deps FROM ITS PINNED package-lock.json into an on-disk
# node_modules tree that EXCLUDES the target itself, then (later) mount it into a
# FULLY net-off container R. Allowlist-by-construction: the target simply isn't there.
#
# Why this excludes the target for free: oh-my-logo is the ROOT package of its own
# lockfile, so `npm ci` installs its DEPENDENCIES into node_modules but never the
# root — the target is absent by construction. We assert it anyway.
#
# Pipeline: clone@SHA (host) -> npm ci (net on) -> node_modules of deps+devDeps ->
#           assert target absent -> publish to runs/run-<id>/vendor/ + listing.
#
# Usage: vendor-deps.sh [target] [run-id]
set -euo pipefail
LIB_TAG=vendor
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd git docker node npm

TARGET="${1:-oh-my-logo}"
RUN_ID="${2:?usage: vendor-deps.sh <target> <run-id>}"
CONFIG="$EVAL_DIR/targets/$TARGET/config.json"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
VENDOR_DIR="$RUN_DIR/vendor"
PREP_DIR="$RUN_DIR/.vendor-prep"
[ -f "$CONFIG" ] || abort "no config at $CONFIG"

REPO=$(cfg "$CONFIG" source.repoUrl)
SHA=$(cfg "$CONFIG" source.sha)

mkdir -p "$RUN_DIR"
saferm "$VENDOR_DIR" "$RUN_DIR" || true
saferm "$PREP_DIR" "$RUN_DIR" || true
mkdir -p "$VENDOR_DIR"

# ---- 1. clone @ pinned SHA (host, network ON) -----------------------------
log "cloning $TARGET @ $SHA for dep resolution (net ON, host) ..."
git clone --quiet "$REPO" "$PREP_DIR" 2>&1 | tee "$RUN_DIR/vendor-clone.log" || abort "git clone failed"
git -C "$PREP_DIR" checkout --quiet "$SHA" 2>&1 | tee -a "$RUN_DIR/vendor-clone.log" || abort "checkout $SHA failed"
[ "$(git -C "$PREP_DIR" rev-parse HEAD)" = "$SHA" ] || abort "prep HEAD != $SHA"
[ -f "$PREP_DIR/package-lock.json" ] || abort "no package-lock.json @ $SHA — cannot vendor deterministically"

# ---- 2. npm ci against the pinned lockfile (net ON) -----------------------
# `npm ci` installs the EXACT pinned tree (deps + devDeps: build=typescript, score=
# vitest+tsx). The root package (the target) is NOT a node_modules entry.
log "npm ci against pinned lockfile (net ON) — installs deps+devDeps, NOT the target root ..."
( cd "$PREP_DIR" && npm ci --no-audit --no-fund ) > "$RUN_DIR/vendor-npm-ci.log" 2>&1 \
  || abort "npm ci failed — see vendor-npm-ci.log"
[ -d "$PREP_DIR/node_modules" ] || abort "npm ci produced no node_modules"

# ---- 3. assert the TARGET is absent from the vendored set ------------------
if [ -e "$PREP_DIR/node_modules/$TARGET" ]; then
  abort "VENDOR BREACH: target package '$TARGET' is present in node_modules — would allow fraudulent rebuild"
fi

# ---- 4. publish vendor set + listing --------------------------------------
mv "$PREP_DIR/node_modules" "$VENDOR_DIR/node_modules"
TOP_COUNT=$(find "$VENDOR_DIR/node_modules" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')
{
  echo "===== vendored deps for $TARGET @ $SHA (target EXCLUDED by construction) ====="
  echo "timestamp(host clock not used in scripts): see file mtime"
  echo "top-level node_modules entries: $TOP_COUNT"
  echo
  echo "--- target presence check ---"
  if [ -e "$VENDOR_DIR/node_modules/$TARGET" ]; then echo "TARGET PRESENT: $TARGET  <<< BREACH"; else echo "TARGET ABSENT: $TARGET  (OK)"; fi
  echo
  echo "--- sample of expected deps present (build/score toolchain) ---"
  for d in typescript vitest tsx figlet gradient-string ink react; do
    if [ -e "$VENDOR_DIR/node_modules/$d" ]; then echo "  present: $d"; else echo "  MISSING: $d"; fi
  done
  echo
  echo "--- full top-level listing ---"
  ( cd "$VENDOR_DIR/node_modules" && ls -1 | sort )
} > "$VENDOR_DIR/vendor-listing.txt"

# strip the prep checkout (we keep only node_modules); the target source must not linger
saferm "$PREP_DIR" "$RUN_DIR" || true

VENDOR_SIZE=$(du -sh "$VENDOR_DIR/node_modules" 2>/dev/null | cut -f1)
log "vendored $TOP_COUNT top-level packages ($VENDOR_SIZE); target '$TARGET' ABSENT."
log "vendor set: $VENDOR_DIR/node_modules"
log "listing:    $VENDOR_DIR/vendor-listing.txt"
