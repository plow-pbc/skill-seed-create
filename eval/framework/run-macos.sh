#!/usr/bin/env bash
# End-to-end run orchestrator — the macos-vm lane (Chunk 5, §4 stages over SSH + §5 folder).
# Runs ON THE HOST (neo). Drives the four named stages into the COMPLETE §5 run folder,
# N times (SERIAL — ~1 VM on 8 GB), with egress logged + leakage audited on this lane.
#
#   Setup        : setup-macos.sh (build original + assert oracle green + capture reference
#                  IN A GUEST; verify the guest is clean of oracle/). Run once.
#   Seed Creator : ON THE HOST, file-tools-only, full source/ visible → run/seed/ (+capture.jsonl)
#   Seed Installer: a FRESH guest (clean of oracle); the cook builds FROM THE SEED ALONE IN THE
#                  GUEST over plain NAT through the egress proxy (denylist active) → run/rebuild/
#                  + egress.log + run/transcripts/rebuild.jsonl
#   Evaluator    : build+run the install IN THE GUEST vs the hidden oracle → run/score/
#   Egress proof : guest→proxy→{benign ALLOW, target DENY} over plain NAT → run/egress-proof.log
#   Leakage audit: leakage-audit.mjs over egress.log + rebuild.jsonl → INVALIDATED runs re-run.
#
# Usage: run-macos.sh <target> [--runs N] [--max-attempts M] [--skill-repo DIR]
set -uo pipefail
MVM_TAG=run-macos
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$FW_DIR/lib-macos.sh"
mvm_require
command -v claude >/dev/null 2>&1 || mabort "claude CLI not found on host (needed for the Creator/Installer cooks)"

TARGET="${1:-trivial-macos}"; shift || true
N=1; MAX_ATTEMPTS=""
SKILL_REPO="${SEED_CREATE_REPO:-$HOME/eval-macos/skill-seed-create}"
while [ $# -gt 0 ]; do case "$1" in
  --runs) N="$2"; shift 2;; --max-attempts) MAX_ATTEMPTS="$2"; shift 2;;
  --skill-repo) SKILL_REPO="$2"; shift 2;;
  *) mabort "unknown arg: $1";; esac; done
MAX_ATTEMPTS="${MAX_ATTEMPTS:-$((N * 2))}"
[ -d "$SKILL_REPO" ] || mabort "seed-create skill repo not found at $SKILL_REPO (pass --skill-repo or set SEED_CREATE_REPO)"

RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || mabort "dispatch failed"
TMP=$(mktemp); printf '%s\n' "$RESOLVED" > "$TMP"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP" "$1"; }
[ "$(jget runner.id)" = "macos-vm" ] || mabort "run-macos.sh is the macos-vm lane; manifest selects '$(jget runner.id)'"
GOLDEN=$(jget environment.image)
CRITERIA="$(jget oracle.criteria)"
BIN=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.criteria[0]&&c.criteria[0].check&&c.criteria[0].check.bin)||".build/release/app")' "$CRITERIA")
EVAL_DIR="$EVAL_ROOT/evals/$TARGET"; SOURCE_DIR="$EVAL_DIR/source"; RUNS="$EVAL_DIR/runs"
mkdir -p "$RUNS"

# Synthetic target identity for the leakage denylist (trivial target is unpublished/fake).
DENY_PACKAGE="greet-cli"; DENY_HOST="greet-cli.invalid"; TARGET_REPO="https://greet-cli.invalid/greet"
BENIGN_HOST="example.com"
PORT=8911

# ---- Setup (once) --------------------------------------------------------------
SETUP_GREEN=$([ -f "$EVAL_DIR/oracle/setup.json" ] && node -e 'try{process.stdout.write(require(process.argv[1]).status)}catch(e){process.stdout.write("none")}' "$EVAL_DIR/oracle/setup.json" || echo none)
if [ "$SETUP_GREEN" != "green" ]; then
  mlog "Setup not green — running setup-macos.sh ..."
  bash "$FW_DIR/setup-macos.sh" "$TARGET" || mabort "Setup failed"
fi
mlog "Setup green. target=$TARGET golden=$GOLDEN bin=$BIN deny={pkg:$DENY_PACKAGE host:$DENY_HOST}"

# one full attempt → 0 if VALID, 8 if INVALIDATED, 1 on hard error
one_run() {
  local label="$1" RUN_DIR="$RUNS/$label"
  rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR/seed" "$RUN_DIR/rebuild" "$RUN_DIR/transcripts" "$RUN_DIR/score/evidence"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local egress="$RUN_DIR/egress.log"; : > "$egress"
  local capEgress="$RUN_DIR/capture-egress.log"
  echo '{"note":"Seed Creator runs ON THE HOST, file-tools-only (no shell) — it has no target-fetch egress path. The meaningful install egress is the Installer guest egress in egress.log."}' > "$capEgress"

  # ---------- Seed Creator (host; full source/) ----------
  mlog "[$label] Seed Creator (host, file-tools-only): capturing seed from full source ..."
  local CW="$RUN_DIR/.creator-ws"; rm -rf "$CW"; mkdir -p "$CW"
  ( cd "$SOURCE_DIR" && tar --exclude=.build --exclude=.git -cf - . ) | ( cd "$CW" && tar -xf - )
  bash "$FW_DIR/stage-cook-macos.sh" creator "$label" "$CW" "$capEgress" \
    --skill-repo "$SKILL_REPO" --seed-out "$RUN_DIR/seed" --transcript "$RUN_DIR/transcripts/capture.jsonl" \
    || mabort "[$label] Seed Creator failed"

  # ---------- fresh per-run guest (clean of oracle) ----------
  local VM="eval-${TARGET}-${label}"
  mlog "[$label] cloning a FRESH guest ($VM) for the blind install ..."
  mvm_clone "$GOLDEN" "$VM"; mvm_boot "$VM"
  local IP; IP=$(mvm_wait_ssh "$VM" 240)
  mvm_strip_oracle "$IP"
  bash "$FW_DIR/verify-image-clean.sh" "$IP" "$TARGET" "eval/$TARGET/install" > "$RUN_DIR/score/evidence/image-clean.json" \
    || { mvm_delete "$VM"; mabort "[$label] guest NOT clean of oracle — aborting (blindness breach)"; }
  local GW; GW=$(mvm_gateway "$IP")
  mlog "[$label] guest $VM up at $IP (gateway $GW); image-clean verified"

  # ---------- Seed Installer (guest build; seed only; denylist active) ----------
  mlog "[$label] Seed Installer: rebuilding FROM THE SEED ALONE, building in the guest ..."
  local IW="$RUN_DIR/.installer-ws"; rm -rf "$IW"; mkdir -p "$IW"
  cp -R "$RUN_DIR/seed/." "$IW/"
  find "$IW" -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true
  node "$EVAL_ROOT/harness/strip-seed-source.mjs" "$IW" "$RUN_DIR" > "$RUN_DIR/score/evidence/seed-strip.log" 2>&1 \
    || mabort "[$label] seed source-strip failed (installer must get seed-only)"
  bash "$FW_DIR/stage-cook-macos.sh" installer "$label" "$IW" "$egress" \
    --guest-ip "$IP" --guest-ws "eval/$TARGET/install" --proxy "$GW:$PORT" --port "$PORT" --bin "$BIN" \
    --transcript "$RUN_DIR/transcripts/rebuild.jsonl" --rebuild-out "$RUN_DIR/rebuild" \
    --deny-package "$DENY_PACKAGE" --deny-host "$DENY_HOST" \
    || mlog "[$label] installer cook exited non-zero (a failed build is an honest outcome; scoring will reflect it)"

  # ---------- Egress proof over plain NAT (capture + denylist) ----------
  mlog "[$label] Egress proof: guest→proxy→{benign ALLOW, target DENY} over plain NAT ..."
  local eproof="$RUN_DIR/egress-proof.log"; : > "$eproof"
  node "$FW_DIR/egress-proxy.mjs" --port "$PORT" --log "$eproof" --deny-host "$DENY_HOST" > "$RUN_DIR/.eproxy.out" 2>&1 &
  local epp=$!
  for _ in $(seq 1 30); do grep -q PROXY-READY "$RUN_DIR/.eproxy.out" && break; sleep 0.3; done
  mvm_gexec "$IP" "curl -s -m 12 -o /dev/null -x http://$GW:$PORT https://$BENIGN_HOST/ ; echo benign-rc=\$?" >> "$RUN_DIR/.eproxy.out" 2>&1 || true
  mvm_gexec "$IP" "curl -s -m 12 -o /dev/null -x http://$GW:$PORT https://$DENY_HOST/ ; echo target-rc=\$?" >> "$RUN_DIR/.eproxy.out" 2>&1 || true
  sleep 1; kill -TERM "$epp" 2>/dev/null || true
  local nAllow nDeny
  nAllow=$(grep -c '"action":"ALLOW"' "$eproof" 2>/dev/null || echo 0)
  nDeny=$(grep -c '"action":"DENY"' "$eproof" 2>/dev/null || echo 0)
  mlog "[$label] egress proof: $nAllow ALLOW + $nDeny DENY logged over plain NAT (benign=$BENIGN_HOST, denied=$DENY_HOST)"

  # ---------- Evaluator ----------
  mlog "[$label] Evaluator: scoring the install in the guest ..."
  bash "$FW_DIR/evaluate-macos.sh" "$TARGET" --rebuild "$RUN_DIR/rebuild" --seed "$RUN_DIR/seed" \
    --guest-ip "$IP" --guest-ws "eval/$TARGET/score" --score-out "$RUN_DIR/score" --label "$label" \
    || mlog "[$label] evaluate returned non-zero"

  # ---------- Leakage audit (post-hoc, invalidating) ----------
  mlog "[$label] Leakage audit ..."
  node "$FW_DIR/leakage-audit.mjs" "$egress" "$RUN_DIR/transcripts/rebuild.jsonl" "$RUN_DIR/score/leakage-audit.json" \
    --target-package "$DENY_PACKAGE" --target-host "$DENY_HOST" --target-repo "$TARGET_REPO"
  local arc=$?

  # ---------- run.json + run-summary.md ----------
  node -e '
  const fs=require("fs");
  const [out, label, target, ts, golden, scP, laP, eproof] = process.argv.slice(1);
  const sc=(()=>{try{return JSON.parse(fs.readFileSync(scP,"utf8"))}catch(e){return null}})();
  const la=(()=>{try{return JSON.parse(fs.readFileSync(laP,"utf8"))}catch(e){return null}})();
  const allow=(fs.existsSync(eproof)?fs.readFileSync(eproof,"utf8"):"").split("\n").filter(l=>l.includes("\"action\":\"ALLOW\"")).length;
  const deny=(fs.existsSync(eproof)?fs.readFileSync(eproof,"utf8"):"").split("\n").filter(l=>l.includes("\"action\":\"DENY\"")).length;
  fs.writeFileSync(out, JSON.stringify({
    schemaVersion:1, label, target, timestamp:ts, environment:{type:"macos-vm",image:golden},
    status: la&&la.verdict==="INVALIDATED"?"invalidated":"complete",
    leakageVerdict: la?la.verdict:"not-audited",
    egressProof:{allow,deny,plainNat:true},
    scores: sc&&sc.composition?{successfulInstall:sc.composition.successfulInstall, ourCriteria: sc.dimension1_fidelity.ourCriteria?sc.dimension1_fidelity.ourCriteria.passed+"/"+sc.dimension1_fidelity.ourCriteria.N:null, visual:(sc.dimension1_fidelity.visual||{}).verdict, codeCopy:(sc.dimension2_seedQuality||{}).verdict}:null,
    outputs:{seed:"seed/",rebuild:"rebuild/",transcripts:"transcripts/",egress:"egress.log",egressProof:"egress-proof.log",score:"score/"},
  }, null, 2)+"\n");
  ' "$RUN_DIR/run.json" "$label" "$TARGET" "$ts" "$GOLDEN" "$RUN_DIR/score/scorecard.json" "$RUN_DIR/score/leakage-audit.json" "$eproof"

  {
    echo "# Run $label — $TARGET (macos-vm)"
    echo "- timestamp: $ts"
    echo "- guest golden: $GOLDEN (plain NAT)"
    echo "- leakage: $(node -e 'try{process.stdout.write(require(process.argv[1]).verdict)}catch(e){process.stdout.write("?")}' "$RUN_DIR/score/leakage-audit.json")"
    echo "- egress proof over plain NAT: $nAllow ALLOW / $nDeny DENY"
    echo "- scorecard: $(node -e 'try{const s=require(process.argv[1]);process.stdout.write("successfulInstall="+s.composition.successfulInstall+", our-criteria="+(s.dimension1_fidelity.ourCriteria?s.dimension1_fidelity.ourCriteria.passed+"/"+s.dimension1_fidelity.ourCriteria.N:"n/a")+", visual="+(s.dimension1_fidelity.visual||{}).verdict+", code-copy="+(s.dimension2_seedQuality||{}).verdict)}catch(e){process.stdout.write("(no scorecard)")}' "$RUN_DIR/score/scorecard.json")"
  } > "$RUN_DIR/run-summary.md"

  # ---------- teardown ----------
  rm -rf "$CW" "$IW" "$RUN_DIR/.eproxy.out" 2>/dev/null || true
  mvm_delete "$VM" >/dev/null 2>&1 || true
  return "$arc"
}

valid=0; attempt=0
while [ "$valid" -lt "$N" ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1)); label=$(printf 'run-%02d' "$attempt")
  mlog "===== attempt $attempt (valid so far: $valid/$N) → $label ====="
  set +e; one_run "$label"; rc=$?; set -e
  if [ "$rc" -eq 8 ]; then mlog "===== $label INVALIDATED → discard + re-run ====="
  else valid=$((valid + 1)); mlog "===== $label VALID ($valid/$N) ====="; fi
done

# ---- minimal index.json rollup (macos lane) -----------------------------------
node -e '
const fs=require("fs"); const path=require("path"); const runs=process.argv[1];
const dirs=fs.readdirSync(runs).filter(d=>{try{return fs.statSync(path.join(runs,d)).isDirectory()&&/^run-/.test(d)}catch(e){return false}});
const items=dirs.map(d=>{try{return JSON.parse(fs.readFileSync(path.join(runs,d,"run.json"),"utf8"))}catch(e){return null}}).filter(Boolean);
const valid=items.filter(r=>r.status!=="invalidated");
fs.writeFileSync(path.join(runs,"index.json"), JSON.stringify({schemaVersion:1,lane:"macos-vm",total:items.length,valid:valid.length,runs:items.map(r=>({label:r.label,status:r.status,leakage:r.leakageVerdict,scores:r.scores,egressProof:r.egressProof,link:r.label+"/run.json"}))},null,2)+"\n");
console.log("[index] "+items.length+" run(s), "+valid.length+" valid → "+path.join(runs,"index.json"));
' "$RUNS"

rm -f "$TMP"
[ "$valid" -ge "$N" ] && mlog "DONE: $valid valid run(s); index at $RUNS/index.json" || mabort "exhausted $MAX_ATTEMPTS attempts with only $valid/$N valid runs"
