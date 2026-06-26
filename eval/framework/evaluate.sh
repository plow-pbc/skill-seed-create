#!/usr/bin/env bash
# The Evaluator (Chunk 2, §6 both dimensions + §5 score/ outputs) — docker lane.
#
# Scores an INSTALLED ARTIFACT against the hidden oracle and emits one composable
# scorecard with ALL promised sections:
#   dimension 1 (fidelity): our-criteria X/N + project-tests X/M (held-out copy) + visual
#   dimension 2 (seed quality): code-copy (verbatim-code volume in the seed)
# plus a per-miss failure attribution and the composition rule.
#
# Inputs: an installed artifact (reconstructed src/ + package.json/build config), the
# resolved oracle spec (dispatch), a criteria.json (a Chunk-2 FIXTURE here; real content
# = Chunk 3), the seed (for code-copy), and the held-out tests-locked/ copy (from Setup).
# The held-out copy — never the mutable source/ — is what the project tests run from.
#
# Usage: framework/evaluate.sh <target> --rebuild <dir> --seed <dir> [--criteria <file>] [--label <name>]
set -euo pipefail
LIB_TAG=evaluate
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$EVAL_ROOT/harness/lib.sh"
require_cmd docker node

TARGET="${1:-}"; shift || true
[ -n "$TARGET" ] || abort "usage: evaluate.sh <target> --rebuild <dir> --seed <dir> [--criteria <file>] [--label <name>]"
REBUILD=""; SEED=""; CRITERIA=""; LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD="$2"; shift 2;;
    --seed) SEED="$2"; shift 2;;
    --criteria) CRITERIA="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    *) abort "unknown arg: $1";;
  esac
done
[ -d "$REBUILD" ] || abort "--rebuild dir not found: $REBUILD"
[ -d "$SEED" ] || abort "--seed dir not found: $SEED"
REBUILD=$(cd "$REBUILD" && pwd); SEED=$(cd "$SEED" && pwd)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LABEL="${LABEL:-eval-$(date -u +%Y%m%d-%H%M%S)}"

RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || abort "dispatch failed for $TARGET"
TMP=$(mktemp); printf '%s\n' "$RESOLVED" > "$TMP"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP" "$1"; }

[ "$(jget runner.id)" = "docker" ] || abort "evaluate.sh is the docker lane; manifest selects '$(jget runner.id)'"
IMAGE=$(jget environment.image)
ENVTYPE=$(jget environment.type)
SHA=$(jget source.sha)
INSTALL=$(jget build.install); BUILD=$(jget build.build); TESTSCMD=$(jget testsCmd)
EXPECTED=$(jget setup.expectedTestCount)
CAPTURES=$(jget setup.referenceCaptures)
LOCKED=$(jget setup.testsLockedAbs)
ORACLE_REF=$(jget oracle.reference)
EVAL_DIR="$EVAL_ROOT/evals/$TARGET"
SOURCE_DIR="$EVAL_DIR/source"
[ -n "$CRITERIA" ] || CRITERIA="$(jget oracle.criteria)"
[ -f "$CRITERIA" ] || abort "criteria file not found: $CRITERIA"

RUN_DIR="$EVAL_DIR/runs/$LABEL"
SCORE="$RUN_DIR/score"; EVID="$SCORE/evidence"; EW="$RUN_DIR/eval-workspace"
# CRITICAL: the Evaluator writes ONLY into score/ + eval-workspace/. It MUST NOT delete
# the run dir — run.sh passes runs/<label>/{rebuild,seed,transcripts,egress.log} as inputs
# and the §5 run folder must survive scoring. Clean ONLY our own two subdirs.
mkdir -p "$RUN_DIR"
saferm "$SCORE" "$RUN_DIR" 2>/dev/null || true
saferm "$EW"    "$RUN_DIR" 2>/dev/null || true
mkdir -p "$EVID" "$EW"
log "target=$TARGET label=$LABEL image=$IMAGE"
log "rebuild=$REBUILD"
log "criteria=$CRITERIA  seed=$SEED"

# ---- assemble the eval workspace: install artifact + HELD-OUT tests overlay ----
# The Evaluator runs the held-out tests-locked/ copy, NEVER the mutable source/ — so
# strip any tests the artifact happens to carry, then overlay the locked copy (minus
# its lockfile; deps come from the artifact's own package.json/lockfile).
log "assembling eval workspace (install artifact + held-out test overlay) ..."
cp -R "$REBUILD/." "$EW/"
rm -rf "$EW/__tests__" "$EW/vitest.config.ts" "$EW/node_modules" 2>/dev/null || true
if [ -n "$TESTSCMD" ]; then
  [ -d "$LOCKED" ] || abort "no held-out test copy at $LOCKED (run Setup first)"
  ( cd "$LOCKED" && find . -type f ! -name 'package-lock.json' ) | while read -r f; do
    mkdir -p "$EW/$(dirname "$f")"; cp "$LOCKED/$f" "$EW/$f"
  done
fi

# ---- build the install + run the held-out project tests (one container) -----------
log "container ($IMAGE): $INSTALL -> $BUILD -> own-test-runner -> project tests ..."
rm -f "$EW/.eval-build-ok" "$EW/.eval-tests.json" 2>/dev/null || true
TESTLINE=":"; [ -n "$TESTSCMD" ] && TESTLINE="$TESTSCMD --reporter=default --reporter=json --outputFile=/work/.eval-tests.json"
# Scorer BRINGS ITS OWN TEST RUNNER: install the held-out test toolchain (the original's
# devDeps) into the SCORING COPY (/work = eval-workspace, a copy of the rebuild) with
# --no-save so the rebuild's package.json is never touched. A rebuild that omitted vitest
# can therefore still be scored on the held-out tests instead of tanking on a setup failure.
TESTDEPS=""
if [ -n "$TESTSCMD" ] && [ -f "$EVAL_DIR/oracle/test-runner-deps.json" ]; then
  TESTDEPS=$(node -e 'const d=require(process.argv[1]).specs||[];process.stdout.write(d.join(" "))' "$EVAL_DIR/oracle/test-runner-deps.json")
fi
INSTALL_RUNNER=":"; [ -n "$TESTDEPS" ] && INSTALL_RUNNER="npm install --no-save --no-audit --no-fund $TESTDEPS"
set +e
docker run --rm --network bridge -v "$EW:/work" -w /work "$IMAGE" sh -c "set -e
  $INSTALL
  $BUILD
  echo BUILD_OK > /work/.eval-build-ok
  set +e
  echo '=== scoring harness: bringing own test runner ==='
  $INSTALL_RUNNER
  $TESTLINE
" > "$EVID/build-test.log" 2>&1
set -e
[ -f "$EW/.eval-build-ok" ] && BUILD_OK=true || BUILD_OK=false
log "build ok: $BUILD_OK"
BIN=$(node -e 'try{const b=require(process.argv[1]).bin;process.stdout.write(typeof b==="string"?b:(b&&Object.values(b)[0])||"dist/index.js")}catch(e){process.stdout.write("dist/index.js")}' "$EW/package.json")

# ---- dimension 1: our-criteria (X/N) ----------------------------------------------
if [ "$BUILD_OK" = "true" ]; then
  log "scoring our-criteria (CLI checks) ..."
  node "$FW_DIR/criteria-check.mjs" "$IMAGE" "$EW" "$BIN" "$CRITERIA" "$EVID/criteria.json"
  log "capturing install output on reference argv (for visual) ..."
  node "$FW_DIR/capture-reference.mjs" "$EW" "$EVID/install-ref" "$IMAGE" "$BIN" "$CAPTURES" "$SHA" > "$EVID/install-ref.log" 2>&1 || true
else
  log "build failed — emitting an all-fail criteria result (hard gates cannot pass)"
  node -e 'const fs=require("fs");const spec=JSON.parse(fs.readFileSync(process.argv[1]));const results=spec.criteria.map(c=>({id:c.id,tier:c.tier,category:c.category,description:c.description,check:c.check,pass:false,reasons:["install did not build"],observed:{}}));const gates=results.filter(r=>r.tier==="gate");fs.writeFileSync(process.argv[2],JSON.stringify({section:"our-criteria",criteriaFile:process.argv[1],N:results.length,passed:0,score:0,gates:{total:gates.length,passed:0,failed:gates.map(r=>r.id),note:"informational only — no gating"},graded:{total:results.length-gates.length,passed:0},results},null,2)+"\n")' "$CRITERIA" "$EVID/criteria.json"
fi

# ---- dimension 1: project-tests (X/M) from the held-out copy -----------------------
if [ -n "$TESTSCMD" ]; then
  log "scoring project-tests (held-out copy vs install) ..."
  node "$FW_DIR/score-tests.mjs" "$EW/.eval-tests.json" "$BUILD_OK" "/work" "$EXPECTED" "$EVID/tests.json"
fi

# ---- dimension 1: visual (terminal-output, structural rubric vs reference) ---------
log "scoring visual (terminal-output structural rubric) ..."
if [ -d "$EVID/install-ref" ]; then
  node "$FW_DIR/visual-terminal.mjs" "$ORACLE_REF" "$EVID/install-ref" "$EVID/visual.json"
else
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({section:"visual",present:true,modality:"terminal-output",verdict:"mismatch",meanSimilarity:0,perCapture:[],note:"install produced no output (build failed)"},null,2)+"\n")' "$EVID/visual.json"
fi

# ---- dimension 2: code-copy (essence vs source-dump) -------------------------------
log "scoring code-copy (seed verbatim-code volume vs source/) ..."
node "$FW_DIR/code-copy.mjs" "$SEED" "$SOURCE_DIR" "$EVID/code-copy.json"

# ---- merge -> scorecard.json + run.json + summary ----------------------------------
node "$FW_DIR/emit-scorecard.mjs" "$EVAL_DIR" "$SCORE" "$SEED" "$LABEL" "$TIMESTAMP" "$REBUILD" "$ENVTYPE" "$IMAGE" "$BUILD_OK"

node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,label:process.argv[2],stage:"evaluator-only",timestamp:process.argv[3],environment:{type:process.argv[4],image:process.argv[5]},rebuildDir:process.argv[6],seedDir:process.argv[7],note:"Chunk-2 Evaluator run: score/ only. Full run folder (seed/rebuild/transcripts/egress + multi-run) = Chunk 4."},null,2)+"\n")' \
  "$RUN_DIR/run.json" "$LABEL" "$TIMESTAMP" "$ENVTYPE" "$IMAGE" "$REBUILD" "$SEED"

# scoring done + evidence captured under score/evidence/ — drop the transient eval-workspace/
# entirely so the §5 run folder holds only seed/ rebuild/ transcripts/ egress.log score/ run.json.
saferm "$EW" "$RUN_DIR" 2>/dev/null || rm -rf "$EW" 2>/dev/null || true
rm -f "$TMP"
log "EVALUATOR DONE. scorecard: $SCORE/scorecard.json  (evidence under $EVID)"
