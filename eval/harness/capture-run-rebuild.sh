#!/usr/bin/env bash
# Chunk 4 (part 2) — blind rebuild cook: reconstruct the target's SOURCE from the
# description-only seed and build it against the vendored deps, FULLY net-off.
#
# The cook is a FRESH, ORACLE-NAIVE `claude -p` confined by the FIXED cook-tool-guard:
#  - file tools confined to the rebuild workspace (seed + node_modules + its own src);
#  - Bash confined to a single `docker exec <net-off R>` (host metachars/newlines
#    rejected); Web/Agent/Task denied; deny-by-default.
# It has NEVER seen the oracle/manifest, and the gate makes the tests unreachable —
# no teaching-to-the-test. A LOW or FAILED rebuild is the honest expected outcome;
# the harness records it verbatim (build failure is a valid, classified result).
#
# Records the rebuilt artifact at the moduleSurface mount (runs/run-<id>/rebuilt/)
# for Chunk 5, plus rebuild-build.log + rebuild-result.json + transcript/tool logs.
#
# Usage: capture-run-rebuild.sh <run-id> [target]
set -euo pipefail
LIB_TAG=rebuild-cook
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd claude docker git node

RUN_ID="${1:?usage: capture-run-rebuild.sh <run-id> [target]}"
TARGET="${2:-oh-my-logo}"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/rebuild-workspace"
COOK_DIR="$RUN_DIR/rebuild-cook"
REBUILT_DIR="$RUN_DIR/rebuilt"             # moduleSurface mount for Chunk 5
CONTAINER="$(cat "$RUN_DIR/rebuild-r.name")"
MOUNT_POINT=$(cfg "$EVAL_DIR/targets/$TARGET/config.json" moduleSurface.mountPoint); MOUNT_POINT="${MOUNT_POINT:-src}"

[ -d "$WORKSPACE" ] || abort "no rebuild workspace at $WORKSPACE (run capture-build-r.sh first)"
docker inspect "$CONTAINER" >/dev/null 2>&1 || abort "rebuild container $CONTAINER not running"

saferm "$COOK_DIR" "$RUN_DIR" || true; mkdir -p "$COOK_DIR"
saferm "$REBUILT_DIR" "$RUN_DIR" || true; mkdir -p "$REBUILT_DIR"
SKILL_READ_ROOT="$(skill_install_root seed-install)"

# ---- cook settings: the FIXED blindness gate, scoped to this cook only ----
cat > "$COOK_DIR/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*",
        "hooks": [ { "type": "command",
          "command": "COOK_WORKSPACE=$WORKSPACE COOK_CAPTURE_CONTAINER=$CONTAINER COOK_ALLOW_READ=$SKILL_READ_ROOT node $EVAL_DIR/harness/cook-tool-guard.mjs" } ] }
    ]
  }
}
JSON

PROMPT="You are an autonomous, FRESH rebuild cook for an eval of a SEED. You have NEVER seen this
project's tests or any test manifest, and you must not look for them.

GOAL: in your CURRENT WORKING DIRECTORY there is a description-only SEED (SEED.md + README.md +
maybe scripts/). Read it, then RECONSTRUCT the software's source code from the description and BUILD
it. Reproduce the capability the SEED describes as faithfully as you can from the prose alone.

HARD RULES (enforced by a blindness gate — violations are denied):
- Reconstruct the source as the SEED describes, under a top-level '$MOUNT_POINT/' directory (write
  the files with the Write tool — your file tools are confined to this working directory).
- The dependencies are ALREADY INSTALLED in ./node_modules. There is NO network: do NOT run
  'npm install' / 'npm ci' / 'git clone' (they will fail). Use the deps that are present; if the
  SEED implies a dependency that is not installed, note it and proceed.
- Write any build config you need (e.g. tsconfig.json, package.json) into the working directory.
- To RUN the build / try the program, use Bash confined to the OFFLINE container $CONTAINER:
    docker exec $CONTAINER sh -lc '<one self-contained script; keep ALL pipes/&&/redirects INSIDE
    these single quotes — host-level ; | & < > and newlines are rejected by the gate>'
  Your working dir is mounted at /rebuild inside the container; build there, e.g.
    docker exec $CONTAINER sh -lc 'cd /rebuild && ./node_modules/.bin/tsc -p tsconfig.json 2>&1 | tail -40'
- A build that does not fully succeed is acceptable — do your best, then STOP. Do not fabricate.
- When finished (whether the build passed or failed), print a final line exactly: REBUILD_COMPLETE

Begin."

log "running blind rebuild cook (fresh claude; confined to net-off $CONTAINER) ..."
log "transcript -> $RUN_DIR/rebuild-transcript.jsonl"
set +e
( cd "$WORKSPACE" && timeout 1200 claude -p "$PROMPT" \
    --append-system-prompt "You are a FRESH, oracle-naive rebuild cook. You have never seen this project's tests. Reconstruct the source from the SEED description only. File tools are confined to your working directory; Bash is one 'docker exec $CONTAINER sh -lc ...' (offline; /rebuild=workspace) with host-level ; | & < > \$ and newlines rejected — keep shell logic inside the single quotes. Deps are pre-installed in ./node_modules; no network. A failed build is an acceptable honest outcome. Stop at REBUILD_COMPLETE." \
    --allowedTools "Skill" "Bash" "Read" "Glob" "Grep" "Write" "Edit" "TodoWrite" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" "Task" "AskUserQuestion" "NotebookEdit" \
    --settings "$COOK_DIR/settings.json" \
    --max-turns 160 \
    --output-format stream-json --verbose --include-partial-messages \
    < /dev/null ) > "$RUN_DIR/rebuild-transcript.jsonl" 2> "$RUN_DIR/rebuild-stderr.log"
COOK_RC=$?
set -e
log "rebuild cook exit=$COOK_RC"
node "$EVAL_DIR/harness/cook-transcript-summarize.mjs" "$RUN_DIR/rebuild-transcript.jsonl" "$RUN_DIR" || true
mv "$RUN_DIR/cook-readable.md" "$RUN_DIR/rebuild-readable.md" 2>/dev/null || true
mv "$RUN_DIR/cook-tool-log.txt" "$RUN_DIR/rebuild-tool-log.txt" 2>/dev/null || true

# ---- harness records the rebuilt artifact + a canonical build attempt -------
# A failed build is a VALID outcome (classified by Chunk 5) — never abort on it.
SRC_PRESENT=no; [ -d "$WORKSPACE/$MOUNT_POINT" ] && [ -n "$(ls -A "$WORKSPACE/$MOUNT_POINT" 2>/dev/null)" ] && SRC_PRESENT=yes
log "reconstructed $MOUNT_POINT present: $SRC_PRESENT"

# canonical, recorded build attempt (offline, in R). Try the project's build script,
# else tsc against a tsconfig, else note none — capture verbatim either way.
log "recording a canonical offline build attempt ..."
docker exec "$CONTAINER" sh -lc '
  cd /rebuild || exit 90
  if [ -f package.json ] && node -e "process.exit(require(\"./package.json\").scripts&&require(\"./package.json\").scripts.build?0:1)" 2>/dev/null; then
    echo "[build] npm run build"; npm run build 2>&1; echo "[build] exit=$?"
  elif [ -f tsconfig.json ] && [ -x node_modules/.bin/tsc ]; then
    echo "[build] tsc -p tsconfig.json"; ./node_modules/.bin/tsc -p tsconfig.json 2>&1; echo "[build] exit=$?"
  elif [ -x node_modules/.bin/tsc ]; then
    echo "[build] tsc (no tsconfig)"; ./node_modules/.bin/tsc 2>&1; echo "[build] exit=$?"
  else
    echo "[build] no build configured (no build script / tsconfig / tsc)"; echo "[build] exit=91"
  fi
' > "$RUN_DIR/rebuild-build.log" 2>&1 || true
BUILD_EXIT=$(grep -oE '\[build\] exit=[0-9]+' "$RUN_DIR/rebuild-build.log" | tail -1 | grep -oE '[0-9]+' || echo "")
BUILD_EXIT="${BUILD_EXIT:-unknown}"
log "canonical build exit=$BUILD_EXIT (see rebuild-build.log; a failure here is a valid recorded outcome)"

# FREEZE R before collection (Chunk-4 fix #2 CRITICAL / TOCTOU): the workspace is
# mounted into R, so a cook background process could swap a src file -> symlink between
# the host walk and copy. The canonical build above was the last thing needing R alive;
# stop it now => no live mutation window (safe-collect also opens O_NOFOLLOW).
log "freezing container $CONTAINER before artifact collection (no live mutation window) ..."
docker stop -t 2 "$CONTAINER" >/dev/null 2>&1 || true

# SAFE-COLLECT the rebuilt artifact to the moduleSurface mount for Chunk 5 (Chunk-4
# fix CRITICAL): the SAME shared helper as the seed seam — REFUSE any symlink/special
# in the cook's reconstructed tree (a cook could `ln -s` the target/oracle into src/),
# copy no-deref, assert in-tree, and write a manifest that INCLUDES symlinks (so the
# audit can never hide one). node_modules/.git excluded. Failure here = blindness
# breach, ABORT (distinct from a build failure, which is a valid recorded outcome).
log "safe-collecting rebuilt artifact -> $REBUILT_DIR (moduleSurface=$MOUNT_POINT) ..."
node "$EVAL_DIR/harness/safe-collect.mjs" "$WORKSPACE" "$REBUILT_DIR" \
  --exclude node_modules,.git --manifest "$RUN_DIR/rebuilt-collect.json" --label artifact \
  || abort "rebuilt-artifact safe-collect FAILED (symlink/out-of-tree) — blindness breach. See rebuilt-collect.json"
cp "$RUN_DIR/rebuilt-collect.json" "$RUN_DIR/rebuilt-filelist.txt" 2>/dev/null || true

# REBUILD_COMPLETE marker from the cook's FINAL result (not the prompt echo)
DONE_OK=$(node -e '
const fs=require("fs");const f=process.argv[1];
if(!fs.existsSync(f)){process.stdout.write("no");process.exit()}
const L=fs.readFileSync(f,"utf8").split("\n").filter(Boolean);let r="";
for(const ln of L){let e;try{e=JSON.parse(ln)}catch{continue}if(e.type==="result")r=String(e.result||"")}
process.stdout.write(/REBUILD_COMPLETE/.test(r)?"yes":"no");' "$RUN_DIR/rebuild-transcript.jsonl")

SRC_COUNT=$(cd "$REBUILT_DIR" && find "$MOUNT_POINT" -type f 2>/dev/null | wc -l | tr -d ' ')
cat > "$RUN_DIR/rebuild-result.json" <<JSON
{
  "schemaVersion": 1,
  "target": "$TARGET",
  "runId": "$RUN_ID",
  "seedKind": "description-only",
  "cookExit": $COOK_RC,
  "cookEmittedComplete": "$DONE_OK",
  "moduleSurfaceMount": "$MOUNT_POINT",
  "reconstructedSourcePresent": "$SRC_PRESENT",
  "reconstructedSourceFileCount": $SRC_COUNT,
  "canonicalBuildExit": "$BUILD_EXIT",
  "rebuiltArtifactDir": "$REBUILT_DIR",
  "note": "Build failure / low fidelity is the honest expected outcome for a description-only seed; Chunk 5 classifies it."
}
JSON

echo "=== rebuilt artifact ($MOUNT_POINT) for Chunk 5 ==="
( cd "$REBUILT_DIR" && find "$MOUNT_POINT" -type f 2>/dev/null | sort || echo "(no $MOUNT_POINT reconstructed)" )
echo "=== rebuild-result.json ==="; cat "$RUN_DIR/rebuild-result.json"
log "rebuild done. cookExit=$COOK_RC complete=$DONE_OK build=$BUILD_EXIT src=$SRC_PRESENT($SRC_COUNT files). artifacts under $RUN_DIR"
