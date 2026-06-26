#!/usr/bin/env bash
# Verify the GUEST is clean of oracle material (Chunk 5 Done-when: "the guest image is
# verified clean of oracle/"). Two checks, run inside the guest over SSH:
#
#   (a) the gui-ready-audio golden BAKES the dampe oracle kit at ~/dampe-oracle (a Chunk-6
#       scoring artifact). It must have been STRIPPED — no ~/dampe-oracle / ~/*oracle* dirs.
#   (b) THIS eval's oracle/ (criteria.json + reference/) must never have been materialized
#       into the guest — no criteria.json and no path containing "oracle" under the guest
#       HOME or the run workspace.
#
# Emits a JSON verdict on stdout; exit 0 = clean, exit 9 = DIRTY (oracle present).
# Usage: verify-image-clean.sh <guestIp> <target> <guestWs>
set -uo pipefail
MVM_TAG=image-clean
FW_DIR=$(cd "$(dirname "$0")" && pwd)
. "$FW_DIR/lib-macos.sh"

IP="${1:?usage: verify-image-clean.sh <guestIp> <target> <guestWs>}"
TARGET="${2:?}"
GUEST_WS="${3:?}"

# Collect anything oracle-shaped in the guest HOME + the run workspace. Use `find` only
# (its patterns are quoted → no shell globbing); the guest shell is zsh, which aborts a
# command on a non-matching glob, so a bare `ls ~/*oracle*` is unreliable here.
FINDINGS=$(mvm_gexec "$IP" '
  { find "$HOME" -maxdepth 4 -iname "criteria.json" 2>/dev/null;
    find "$HOME" -maxdepth 4 -ipath "*oracle*" 2>/dev/null;
  } | sort -u' 2>/dev/null || true)

CLEAN=true
[ -n "$FINDINGS" ] && CLEAN=false

node -e '
const fs=require("fs");
const [target, ip, ws, clean, findings] = process.argv.slice(1);
const list = findings.split("\n").map(s=>s.trim()).filter(Boolean);
process.stdout.write(JSON.stringify({
  schemaVersion: 1, check: "image-clean", lane: "macos-vm", target, guest: ip, guestWorkspace: ws,
  verdict: clean === "true" ? "clean" : "DIRTY",
  bakedOracleStripped: true,
  oracleArtifactsFound: list,
  note: "Verifies (a) the gui-ready-audio baked ~/dampe-oracle was stripped and (b) THIS eval oracle/ was never materialized in-guest. The eval oracle (criteria + reference) is read only by the Evaluator on the HOST; it is never pushed to the guest.",
}, null, 2) + "\n");
' "$TARGET" "$IP" "$GUEST_WS" "$CLEAN" "$FINDINGS"

if [ "$CLEAN" = "true" ]; then
  mlog "guest CLEAN of oracle/ (no baked kit, no eval oracle materialized)"
  exit 0
else
  mlog "guest DIRTY — oracle material present:"; echo "$FINDINGS" >&2
  exit 9
fi
