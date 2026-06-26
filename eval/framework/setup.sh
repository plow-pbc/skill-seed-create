#!/usr/bin/env bash
# Setup stage (Chunk 1, §4-Setup) — the docker runner.
#
# Materialize source/ -> build the original -> assert the oracle is GREEN on the
# known-good original (a valid yardstick) -> capture reference evidence into
# oracle/reference/ -> snapshot a HELD-OUT copy of the project's tests into
# oracle/tests-locked/ (scorer-only, so source/ — which the Creator touches — is
# never what the Evaluator runs). A run is only trustworthy if Setup is green.
#
# Network ON (framework default). Aborts LOUDLY (non-zero) if the original won't
# build or the oracle isn't fully green.
#
# Usage: framework/setup.sh [target]
set -euo pipefail
LIB_TAG=setup
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$EVAL_ROOT/harness/lib.sh"   # log / abort / saferm / cfg / require_cmd

require_cmd git docker node
TARGET="${1:-oh-my-logo}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ---- 0. resolve the manifest via the dispatcher (validates + selects runner) --
RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || abort "dispatch failed for $TARGET (invalid manifest?)"
EVAL_DIR="$EVAL_ROOT/evals/$TARGET"
TMP="$EVAL_DIR/.setup"; saferm "$TMP" "$EVAL_DIR" 2>/dev/null || true; mkdir -p "$TMP"
printf '%s\n' "$RESOLVED" > "$TMP/resolved.json"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP/resolved.json" "$1"; }

RUNNER=$(jget runner.id)
[ "$RUNNER" = "docker" ] || abort "setup.sh is the DOCKER runner; manifest selects '$RUNNER' (macos-vm Setup = Chunk 5)"
IMAGE=$(jget environment.image)
REPO=$(jget source.repo); SHA=$(jget source.sha); REF=$(jget source.ref)
INSTALL=$(jget build.install); BUILD=$(jget build.build); TESTSCMD=$(jget testsCmd)
EXPECTED=$(jget setup.expectedTestCount)
LOCKFILE=$(jget setup.lockfile)
TESTGLOBS=$(jget setup.testGlobs)
CAPTURES=$(jget setup.referenceCaptures)
SOURCE_DIR="$EVAL_DIR/source"
ORACLE_DIR="$EVAL_DIR/oracle"
REF_DIR="$ORACLE_DIR/reference"
LOCKED_DIR=$(jget setup.testsLockedAbs)
log "target=$TARGET runner=$RUNNER image=$IMAGE  eval-dir=$EVAL_DIR"
[ -n "$BUILD" ] || abort "manifest has no build commands — docker Setup needs build.install + build.build"

# ---- 1. ensure the logical image (build from framework/images/<image>/ if present) ----
if [ -f "$FW_DIR/images/$IMAGE/Dockerfile" ]; then
  log "building image $IMAGE from framework/images/$IMAGE ..."
  docker build -t "$IMAGE" "$FW_DIR/images/$IMAGE" > "$TMP/image-build.log" 2>&1 || { cat "$TMP/image-build.log"; abort "image build failed"; }
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || abort "image $IMAGE not found and no framework/images/$IMAGE/Dockerfile to build it"
fi

# ---- 2. materialize source/ (clone @ pinned sha; the FULL project the Creator sees) ----
if [ -z "$REPO" ]; then
  [ -d "$SOURCE_DIR" ] && [ -n "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ] || abort "no source.repo in manifest and source/ is empty — nothing to set up"
  log "manifest declares no source.repo; using pre-populated source/"
else
  if [ -d "$SOURCE_DIR/.git" ] && [ "$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null)" = "$SHA" ]; then
    log "source/ already at pinned sha $SHA — reusing"
  else
    log "materializing source/ <- clone $REPO @ ${REF:-$SHA} ..."
    saferm "$SOURCE_DIR" "$EVAL_DIR" 2>/dev/null || true
    git clone --quiet "$REPO" "$SOURCE_DIR" > "$TMP/clone.log" 2>&1 || abort "git clone failed (see $TMP/clone.log)"
    git -C "$SOURCE_DIR" checkout --quiet "$SHA" >> "$TMP/clone.log" 2>&1 || abort "git checkout $SHA failed"
  fi
  HEAD=$(git -C "$SOURCE_DIR" rev-parse HEAD)
  [ "$HEAD" = "$SHA" ] || abort "source/ HEAD ($HEAD) != pinned sha ($SHA)"
  log "source/ anchored at $HEAD"
fi

# ---- 3. build the original + run its tests (json report) IN the environment -------
# set -e through build so a build failure aborts before tests; a build-ok sentinel
# lets the green-gate distinguish build_failed from test failures. Tests run with
# set +e so a red suite still writes a report (the gate then fails it loudly).
rm -f "$SOURCE_DIR/.setup-build-ok" "$SOURCE_DIR/.setup-vitest-report.json" 2>/dev/null || true
log "container ($IMAGE): $INSTALL -> $BUILD -> tests ..."
set +e
docker run --rm --network bridge -v "$SOURCE_DIR:/work" -w /work "$IMAGE" sh -c "set -e
  echo '=== node/npm ==='; node --version; npm --version
  echo '=== install: $INSTALL ==='; $INSTALL
  echo '=== build: $BUILD ==='; $BUILD
  echo BUILD_OK > /work/.setup-build-ok
  echo '=== tests: $TESTSCMD ==='
  set +e
  $TESTSCMD --reporter=default --reporter=json --outputFile=/work/.setup-vitest-report.json
" > "$TMP/container.log" 2>&1
CRC=$?
set -e
log "container exit: $CRC (test failures are surfaced by the green-gate, not here)"
[ -f "$SOURCE_DIR/.setup-build-ok" ] && BUILD_OK=true || BUILD_OK=false
log "build ok: $BUILD_OK"

# ---- 4. capture reference evidence (built CLI invocations -> oracle/reference/) ----
if [ "$BUILD_OK" = "true" ]; then
  BIN=$(node -e 'try{const b=require(process.argv[1]).bin;process.stdout.write(typeof b==="string"?b:(b&&Object.values(b)[0])||"dist/index.js")}catch(e){process.stdout.write("dist/index.js")}' "$SOURCE_DIR/package.json")
  log "capturing reference via CLI bin: $BIN ..."
  node "$FW_DIR/capture-reference.mjs" "$SOURCE_DIR" "$REF_DIR" "$IMAGE" "$BIN" "$CAPTURES" "$SHA" | tee "$TMP/reference.log"
else
  log "skipping reference capture (build failed)"
fi

# ---- 4b. green-gate on OUR criteria on the known-good original (Chunk 3) ------------
# Now that oracle/criteria.json is real content (not the Chunk-1 placeholder), Setup must
# confirm OUR criteria are fully green on the original too — else broken criteria would ship
# inside a green setup.json. Scored on the built source/ (the original artifact).
CRITERIA=$(jget oracle.criteria)
CRIT_RESULT=""
if [ "$BUILD_OK" = "true" ] && [ -n "$CRITERIA" ] && [ -f "$CRITERIA" ]; then
  CRIT_RESULT="$TMP/criteria-original.json"
  log "running OUR criteria on the known-good original (must be fully green) ..."
  node "$FW_DIR/criteria-check.mjs" "$IMAGE" "$SOURCE_DIR" "$BIN" "$CRITERIA" "$CRIT_RESULT" | tee "$TMP/criteria-original.log" || true
elif [ -n "$CRITERIA" ] && [ ! -f "$CRITERIA" ]; then
  log "note: criteria file $CRITERIA not found — our-criteria green-gate skipped"
fi

# ---- 5. snapshot the HELD-OUT test copy (scorer-only) -> oracle/tests-locked/ -----
if [ -n "$TESTSCMD" ]; then
  [ -n "$TESTGLOBS" ] || abort "manifest has tests but no setup.testGlobs — cannot snapshot the held-out copy"
  log "snapshotting held-out test copy -> $LOCKED_DIR ..."
  saferm "$LOCKED_DIR" "$ORACLE_DIR" 2>/dev/null || true
  node "$FW_DIR/snapshot-tests.mjs" "$SOURCE_DIR" "$LOCKED_DIR" "$TESTGLOBS" "$LOCKFILE" > "$TMP/snapshot.json" || abort "test snapshot failed (zero matches?)"
  # Capture the ORIGINAL's devDependencies as the scorer's OWN test-runner manifest. The
  # Evaluator installs these into its SCORING COPY (never the rebuild) so a rebuild missing a
  # test devDep (e.g. vitest) can never tank the number with a setup failure.
  node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8"));const dd=p.devDependencies||{};fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,note:"scorer-only: held-out test toolchain installed into the eval-workspace COPY, never the rebuild",devDependencies:dd,specs:Object.entries(dd).map(([n,v])=>n+"@"+v)},null,2)+"\n")' "$SOURCE_DIR" "$ORACLE_DIR/test-runner-deps.json"
  log "captured scorer test-runner manifest -> oracle/test-runner-deps.json ($(node -e 'console.log(Object.keys(require(process.argv[1]).devDependencies).length)' "$ORACLE_DIR/test-runner-deps.json") devDeps)"
else
  log "no project tests declared — skipping held-out snapshot (criteria/visual only)"
fi

# ---- 6. green-gate + emit oracle/setup.json ---------------------------------------
log "asserting the original is green + emitting oracle/setup.json ..."
set +e
node "$FW_DIR/setup-report.mjs" "$EVAL_DIR" "$SOURCE_DIR/.setup-vitest-report.json" "/work" "$SHA" "$IMAGE" "$BUILD_OK" "$EXPECTED" "$TIMESTAMP" "$CRIT_RESULT"
GRC=$?
set -e
if [ "$GRC" -ne 0 ]; then
  abort "Setup green-gate FAILED (exit $GRC) — see $TMP/container.log and oracle/setup.json. The run is NOT trustworthy."
fi

log "SETUP GREEN. oracle/setup.json + oracle/reference/ + oracle/tests-locked/ ready under $EVAL_DIR"
