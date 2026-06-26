#!/usr/bin/env bash
# The Evaluator — macos-vm lane (Chunk 5, §6 + §5 score/). Scores the INSTALLED artifact
# by building + running it IN THE GUEST, against the hidden oracle on the HOST. Emits the
# same score/ folder shape as the docker Evaluator:
#   dimension 1 (fidelity): our-criteria X/N (guest-cli) + visual (terminal-output vs reference)
#                           [no project tests on this trivial target]
#   dimension 2 (seed quality): code-copy (verbatim-code volume in the seed vs source/)
# plus the composition rule. (Leakage audit is run post-hoc by run-macos.sh.)
#
# Reuses the SHARED pure scorers by CALLING them (not editing): code-copy.mjs,
# visual-terminal.mjs. our-criteria uses the macos guest runner (criteria-check-guest.mjs).
# The scorecard is assembled here (self-contained) rather than via the docker-shaped
# emit-scorecard.mjs, which references project-tests/docker concepts.
#
# Usage: evaluate-macos.sh <target> --rebuild <dir> --seed <dir> --guest-ip <ip>
#          --guest-ws <path> --score-out <dir> [--criteria <file>] [--label <name>]
set -uo pipefail
MVM_TAG=evaluate-macos
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$FW_DIR/lib-macos.sh"

TARGET="${1:?usage: evaluate-macos.sh <target> ...}"; shift
REBUILD=""; SEED=""; CRITERIA=""; LABEL=""; GUEST_IP=""; GUEST_WS=""; SCORE=""
while [ $# -gt 0 ]; do case "$1" in
  --rebuild) REBUILD="$2"; shift 2;; --seed) SEED="$2"; shift 2;;
  --criteria) CRITERIA="$2"; shift 2;; --label) LABEL="$2"; shift 2;;
  --guest-ip) GUEST_IP="$2"; shift 2;; --guest-ws) GUEST_WS="$2"; shift 2;;
  --score-out) SCORE="$2"; shift 2;;
  *) mabort "unknown arg: $1";; esac; done
[ -d "$REBUILD" ] || mabort "--rebuild not found: $REBUILD"
[ -d "$SEED" ] || mabort "--seed not found: $SEED"
[ -n "$GUEST_IP" ] && [ -n "$GUEST_WS" ] && [ -n "$SCORE" ] || mabort "need --guest-ip --guest-ws --score-out"
REBUILD=$(cd "$REBUILD" && pwd); SEED=$(cd "$SEED" && pwd)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LABEL="${LABEL:-eval}"

EVAL_DIR="$EVAL_ROOT/evals/$TARGET"; SOURCE_DIR="$EVAL_DIR/source"
RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || mabort "dispatch failed"
TMP=$(mktemp); printf '%s\n' "$RESOLVED" > "$TMP"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP" "$1"; }
[ -n "$CRITERIA" ] || CRITERIA="$(jget oracle.criteria)"
[ -f "$CRITERIA" ] || mabort "criteria not found: $CRITERIA"
ORACLE_REF="$(jget oracle.reference)"
BUILD_CMD=$(jget build.build)
CAPS=$(jget setup.referenceCaptures)
BIN=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.criteria[0]&&c.criteria[0].check&&c.criteria[0].check.bin)||".build/release/app")' "$CRITERIA")

EVID="$SCORE/evidence"; mkdir -p "$EVID"
mlog "target=$TARGET label=$LABEL guest=$GUEST_IP bin=$BIN"

# ---- locate the rebuilt SwiftPM package inside the artifact --------------------
# The installer reconstructs ./src/ (Package.swift). Find the dir holding Package.swift.
PKG_REL=$(cd "$REBUILD" && { [ -f Package.swift ] && echo "." || { [ -f src/Package.swift ] && echo "src" || find . -maxdepth 3 -name Package.swift -exec dirname {} \; | head -1; }; })
PKG_REL="${PKG_REL:-src}"
BUILD_OK=false
if [ -f "$REBUILD/$PKG_REL/Package.swift" ]; then
  mlog "rebuilt package at: $PKG_REL — building in guest for evaluation"
  mvm_gexec "$GUEST_IP" "rm -rf '$GUEST_WS' && mkdir -p '$GUEST_WS'" >/dev/null 2>&1
  mvm_gpush "$GUEST_IP" "$REBUILD/$PKG_REL/" "$GUEST_WS/"
  # fresh build: drop any stale .build (absolute module-cache paths) that rode along
  mvm_gexec "$GUEST_IP" "cd '$GUEST_WS' && rm -rf .build" >/dev/null 2>&1
  mvm_gexec "$GUEST_IP" "cd '$GUEST_WS' && ${BUILD_CMD:-swift build -c release}" > "$EVID/build.log" 2>&1 \
    && mvm_gexec "$GUEST_IP" "cd '$GUEST_WS' && test -x '$BIN'" && BUILD_OK=true || BUILD_OK=false
else
  mlog "no Package.swift in the rebuilt artifact — install did not produce a buildable package"
fi
mlog "rebuild build ok: $BUILD_OK"

# ---- dimension 1: our-criteria (guest-cli) ------------------------------------
if [ "$BUILD_OK" = "true" ]; then
  node "$FW_DIR/criteria-check-guest.mjs" "$GUEST_IP" "$GUEST_WS" "$CRITERIA" "$EVID/criteria.json"
  # capture the install's output on the reference argv (for the visual rubric)
  mkdir -p "$EVID/install-ref"
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).map(c=>c.id+"\t"+JSON.stringify(c.argv||[])).join("\n")+"\n")' "$CAPS" > "$TMP.caps"
  while IFS=$'\t' read -r id argvjson; do
    [ -n "$id" ] || continue
    ARGS=$(node -e 'process.stdout.write((JSON.parse(process.argv[1])||[]).map(a=>"\x27"+String(a).replace(/\x27/g,"\x27\\\x27\x27")+"\x27").join(" "))' "$argvjson")
    mvm_gexec "$GUEST_IP" "cd '$GUEST_WS' && ./$BIN $ARGS" > "$EVID/install-ref/$id.txt" 2>/dev/null || true
  done < "$TMP.caps"
  mvm_gcapture "$GUEST_IP" "$EVID/install-desktop.png" 2>/dev/null || true
else
  mlog "build failed — emitting all-fail criteria (hard gates cannot pass)"
  node -e 'const fs=require("fs");const spec=JSON.parse(fs.readFileSync(process.argv[1]));const results=spec.criteria.map(c=>({id:c.id,tier:c.tier,category:c.category,description:c.description,check:c.check,pass:false,reasons:["install did not build in the guest"],observed:{}}));const gates=results.filter(r=>r.tier==="gate");fs.writeFileSync(process.argv[2],JSON.stringify({section:"our-criteria",lane:"macos-vm",criteriaFile:process.argv[1],N:results.length,passed:0,score:0,hardGateFailed:gates.length>0,gates:{total:gates.length,passed:0,failed:gates.map(r=>r.id)},graded:{total:results.length-gates.length,passed:0},results},null,2)+"\n")' "$CRITERIA" "$EVID/criteria.json"
fi

# ---- dimension 1: visual (terminal-output structural rubric vs reference) ------
if [ -d "$EVID/install-ref" ] && [ -f "$ORACLE_REF/index.json" ]; then
  node "$FW_DIR/visual-terminal.mjs" "$ORACLE_REF" "$EVID/install-ref" "$EVID/visual.json" || true
else
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({section:"visual",present:true,modality:"terminal-output",verdict:"mismatch",meanSimilarity:0,perCapture:[],note:"install produced no output (build failed)"},null,2)+"\n")' "$EVID/visual.json"
fi

# ---- dimension 2: code-copy (essence vs source-dump) --------------------------
node "$FW_DIR/code-copy.mjs" "$SEED" "$SOURCE_DIR" "$EVID/code-copy.json"

# ---- merge → scorecard.json (macos lane; self-contained) ----------------------
node -e '
const fs=require("fs");
const [out, target, label, ts, evid, buildOk] = process.argv.slice(1);
const rd = (p,d=null)=>{ try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return d; } };
const crit = rd(evid+"/criteria.json");
const visual = rd(evid+"/visual.json");
const codecopy = rd(evid+"/code-copy.json");
const hardGateFailed = !crit || crit.hardGateFailed || buildOk!=="true";
const successfulInstall = buildOk==="true" && crit && !crit.hardGateFailed;
// failure attribution (heuristic, named as such) — does the seed mention a missed behavior?
const attrib = [];
if (crit) for (const r of crit.results.filter(r=>!r.pass)) {
  attrib.push({ id:r.id, tier:r.tier, category:r.category,
    attribution: buildOk!=="true" ? "installer-failure (no buildable artifact)" : "installer-failure or seed-ambiguity (behavior missing in rebuild)",
    reasons:r.reasons });
}
const card = {
  schemaVersion: 1, lane: "macos-vm", target, label, timestamp: ts,
  environment: { type: "macos-vm" },
  composition: {
    buildOk: buildOk==="true", hardGateFailed, successfulInstall,
    rule: "macos-vm: a build/launch/core-action gate failure (or no buildable artifact) ⇒ not a successful install; otherwise sections report independently.",
  },
  dimension1_fidelity: {
    ourCriteria: crit ? { passed: crit.passed, N: crit.N, score: crit.score, gates: crit.gates, hardGateFailed: crit.hardGateFailed } : null,
    projectTests: null,
    visual: visual ? { verdict: visual.verdict, meanSimilarity: visual.meanSimilarity, captures: (visual.perCapture||[]).length } : null,
  },
  dimension2_seedQuality: codecopy ? { verdict: codecopy.verdict, flagged: codecopy.flagged, fenceRatio: codecopy.fenceRatio, longestVerbatimBlock: codecopy.longestVerbatimBlock.lines, totalVerbatimLines: codecopy.totalVerbatimLines } : null,
  failureAttribution: attrib,
  evidence: { criteria: "evidence/criteria.json", visual: "evidence/visual.json", codeCopy: "evidence/code-copy.json", buildLog: "evidence/build.log", installDesktop: fs.existsSync(evid+"/install-desktop.png") ? "evidence/install-desktop.png" : null },
};
fs.writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
const c = card.dimension1_fidelity.ourCriteria;
console.log("[scorecard] successfulInstall="+card.composition.successfulInstall+" our-criteria="+(c?c.passed+"/"+c.N:"n/a")+" visual="+(card.dimension1_fidelity.visual||{}).verdict+" code-copy="+(card.dimension2_seedQuality||{}).verdict);
' "$SCORE/scorecard.json" "$TARGET" "$LABEL" "$TIMESTAMP" "$EVID" "$BUILD_OK"

rm -f "$TMP" "$TMP.caps" 2>/dev/null || true
mlog "EVALUATOR DONE. scorecard: $SCORE/scorecard.json (evidence under $EVID)"
