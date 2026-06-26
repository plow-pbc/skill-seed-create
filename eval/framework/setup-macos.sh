#!/usr/bin/env bash
# Setup stage — the macos-vm runner (§4-Setup + §8). Runs ON THE HOST (neo);
# builds the original + runs the oracle IN A HEADLESS GUEST over SSH (plain NAT).
#
#   1. clone the golden image (environment.image) → a setup guest; boot plain-NAT; wait for SSH;
#      STRIP any oracle material baked into the golden (defense: a golden image may bake an
#      oracle kit under the guest HOME — it must never be visible to an agent).
#   2. push source/ into the guest; build the original (build.build) in the guest.
#   3. green-gate: run our-criteria against the known-good original IN THE GUEST; a run is
#      only trustworthy if every criterion passes (no project tests on this trivial target,
#      so our-criteria IS the green yardstick).
#   4. capture reference evidence: run each setup.referenceCaptures argv against the built
#      binary in the guest; save stdout → oracle/reference/<id>.txt (+ index.json). Pull a
#      desktop screenshot too (proves the GUI/visual lane).
#   5. verify the guest is CLEAN of this eval's oracle/ (none of it was materialized in-guest).
#   6. emit oracle/setup.json (status green) and tear the setup guest down.
#
# Aborts LOUDLY (non-zero) if the original won't build or the oracle isn't fully green.
# Usage: setup-macos.sh <target>
set -uo pipefail
MVM_TAG=setup-macos
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$FW_DIR/lib-macos.sh"
mvm_require
command -v node >/dev/null 2>&1 || mabort "node not found on host"

TARGET="${1:?usage: setup-macos.sh <target>}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EVAL_DIR="$EVAL_ROOT/evals/$TARGET"
SOURCE_DIR="$EVAL_DIR/source"
ORACLE_DIR="$EVAL_DIR/oracle"
REF_DIR="$ORACLE_DIR/reference"
LOCKED_DIR="$ORACLE_DIR/tests-locked"

RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || mabort "dispatch failed for $TARGET"
TMP="$EVAL_DIR/.setup-macos"; rm -rf "$TMP"; mkdir -p "$TMP"
printf '%s\n' "$RESOLVED" > "$TMP/resolved.json"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP/resolved.json" "$1"; }

[ "$(jget runner.id)" = "macos-vm" ] || mabort "setup-macos.sh is the macos-vm runner; manifest selects '$(jget runner.id)'"
GOLDEN=$(jget environment.image)
BUILD_CMD=$(jget build.build); [ -n "$BUILD_CMD" ] || mabort "manifest has no build.build — macos Setup needs a guest build command"
CRITERIA="$(jget oracle.criteria)"
[ -f "$CRITERIA" ] || mabort "criteria not found: $CRITERIA"
BIN=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.criteria[0]&&c.criteria[0].check&&c.criteria[0].check.bin)||".build/release/app")' "$CRITERIA")
[ -d "$SOURCE_DIR" ] && [ -n "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ] || mabort "source/ is empty — nothing to set up (this lane uses a pre-populated source/)"

VM="eval-${TARGET}-setup"
GUEST_WS="eval/${TARGET}/setup"

mlog "target=$TARGET golden=$GOLDEN build='$BUILD_CMD' bin=$BIN"
trap 'mvm_delete "$VM" >/dev/null 2>&1 || true' EXIT

# ---- 1. fresh guest -------------------------------------------------------------
mvm_clone "$GOLDEN" "$VM"
mvm_boot "$VM"
IP=$(mvm_wait_ssh "$VM" 240)
mlog "guest up at $IP — stripping any baked oracle material (defense)"
mvm_strip_oracle "$IP"

# ---- 2. push source + build the original in the guest ---------------------------
mvm_gexec "$IP" "rm -rf '$GUEST_WS' && mkdir -p '$GUEST_WS'" >/dev/null 2>&1
mvm_gpush "$IP" "$SOURCE_DIR/" "$GUEST_WS/"
mlog "building original in guest: $BUILD_CMD"
mvm_gexec "$IP" "cd '$GUEST_WS' && $BUILD_CMD" > "$TMP/build.log" 2>&1
BRC=$?
if [ "$BRC" -ne 0 ]; then cat "$TMP/build.log"; mabort "original failed to build in the guest (rc=$BRC) — Setup not green"; fi
mvm_gexec "$IP" "cd '$GUEST_WS' && test -x '$BIN'" || { cat "$TMP/build.log"; mabort "built binary not found/executable at $BIN"; }
mlog "original built OK ($BIN present)"

# ---- 3. green-gate: our-criteria on the known-good original ---------------------
mlog "asserting the oracle is GREEN on the original (our-criteria in guest) ..."
node "$FW_DIR/criteria-check-guest.mjs" "$IP" "$GUEST_WS" "$CRITERIA" "$TMP/criteria-original.json" || mabort "criteria runner errored"
GREEN=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.passed===r.N&&!r.hardGateFailed?"green":"red")' "$TMP/criteria-original.json")
PASSED=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.passed+"/"+r.N)' "$TMP/criteria-original.json")
mlog "our-criteria on original: $PASSED ($GREEN)"
[ "$GREEN" = "green" ] || { cat "$TMP/criteria-original.json"; mabort "oracle is NOT green on the original ($PASSED) — the run would not be a valid yardstick"; }

# ---- 4. capture reference evidence (built binary in guest) ----------------------
mlog "capturing reference evidence → $REF_DIR"
rm -rf "$REF_DIR"; mkdir -p "$REF_DIR"
CAPS=$(jget setup.referenceCaptures)
# Run each capture's argv against the built binary in the guest; save stdout.
node -e '
const caps = JSON.parse(process.argv[1]);
process.stdout.write(caps.map(c => c.id + "\t" + JSON.stringify(c.argv||[])).join("\n") + "\n");
' "$CAPS" > "$TMP/caps.tsv"
declare -a CAP_INDEX=()
while IFS=$'\t' read -r id argvjson; do
  [ -n "$id" ] || continue
  ARGS=$(node -e 'process.stdout.write((JSON.parse(process.argv[1])||[]).map(a=>"\x27"+String(a).replace(/\x27/g,"\x27\\\x27\x27")+"\x27").join(" "))' "$argvjson")
  mvm_gexec "$IP" "cd '$GUEST_WS' && ./$BIN $ARGS" > "$REF_DIR/$id.txt" 2>/dev/null || true
  mlog "  reference[$id] argv=$argvjson → $id.txt ($(wc -c < "$REF_DIR/$id.txt" | tr -d ' ') bytes)"
  CAP_INDEX+=("$id"$'\t'"$argvjson")
done < "$TMP/caps.tsv"
# desktop screenshot (proves the visual/GUI lane is wired even on a CLI target)
mvm_gcapture "$IP" "$REF_DIR/desktop.png" 2>/dev/null && mlog "  reference desktop.png captured" || mlog "  (screenshot skipped)"
# write index.json (the shape visual-terminal.mjs consumes)
node -e '
const fs=require("fs");
const [refDir, capsJson] = [process.argv[1], process.argv[2]];
const caps = JSON.parse(capsJson).map(c => ({ id: c.id, file: c.id + ".txt", argv: c.argv||[] }));
fs.writeFileSync(refDir + "/index.json", JSON.stringify({ schemaVersion:1, lane:"macos-vm", captures: caps }, null, 2) + "\n");
' "$REF_DIR" "$CAPS"

# ---- 5. snapshot held-out tests (none on this target) ---------------------------
TESTSCMD=$(jget testsCmd)
if [ -n "$TESTSCMD" ]; then
  mabort "macos Setup test-snapshot not implemented for this target (trivial-macos has no tests)"
else
  mlog "no project tests declared — skipping held-out snapshot (criteria/visual only)"
  rm -rf "$LOCKED_DIR"; mkdir -p "$LOCKED_DIR"
  echo "this target has no project tests (criteria + visual only)" > "$LOCKED_DIR/NO-TESTS.txt"
fi

# ---- 6. verify the guest is CLEAN of this eval's oracle -------------------------
mlog "verifying the guest is clean of this eval's oracle/ ..."
bash "$FW_DIR/verify-image-clean.sh" "$IP" "$TARGET" "$GUEST_WS" > "$TMP/image-clean.json" || mabort "image-clean verification FAILED — oracle material present in guest"
cp "$TMP/image-clean.json" "$ORACLE_DIR/image-clean.json"
mlog "image-clean: $(node -e 'process.stdout.write(require(process.argv[1]).verdict)' "$ORACLE_DIR/image-clean.json")"

# ---- 7. emit oracle/setup.json --------------------------------------------------
node -e '
const fs=require("fs");
const [out, target, golden, bin, ts, critFile, refDir, lockedDir, passed, green] = process.argv.slice(1);
const crit = JSON.parse(fs.readFileSync(critFile,"utf8"));
const ref = JSON.parse(fs.readFileSync(refDir + "/index.json","utf8"));
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1, stage: "setup", lane: "macos-vm", target, environment: { type:"macos-vm", image: golden },
  bin, timestamp: ts, status: green==="green" ? "green":"red",
  greenSignal: "our-criteria (no project tests on this target)",
  oracleGreen: { passed, file: "oracle/criteria.json" },
  reference: { dir: "oracle/reference/", captures: ref.captures.map(c=>c.id), screenshot: fs.existsSync(refDir+"/desktop.png") },
  testsLocked: "oracle/tests-locked/ (none — no project tests)",
  imageClean: "oracle/image-clean.json",
}, null, 2) + "\n");
' "$ORACLE_DIR/setup.json" "$TARGET" "$GOLDEN" "$BIN" "$TIMESTAMP" "$CRITERIA" "$REF_DIR" "$LOCKED_DIR" "$PASSED" "$GREEN"

mlog "SETUP GREEN. oracle/setup.json + oracle/reference/ + oracle/image-clean.json ready under $EVAL_DIR"
mvm_delete "$VM" >/dev/null 2>&1 || true
trap - EXIT
