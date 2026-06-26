#!/usr/bin/env bash
# End-to-end run orchestrator — docker lane, NETWORK-ON.
#
# Drives the four named stages into the COMPLETE §5 run folder, N times, and rolls up
# runs/index.json. Blindness is enforced by WHAT'S IN THE WORKSPACE (Global Constraints:
# no net-off) + the post-hoc leakage audit + the active target denylist:
#
#   Setup        : framework/setup.sh (build original, assert oracle green, capture
#                  reference, snapshot held-out tests). Run once (idempotent).
#   Seed Creator : net-ON container with the FULL source/ (the realistic input); runs
#                  evalseed:seed-create via --plugin-dir; egress logged (capture-egress.log).
#                  → run/seed/ + transcripts/capture.jsonl
#   Seed Installer: net-ON container holding ONLY the seed (strip-seed-source re-strips any
#                  bundled source/tests); routed through the egress proxy with the TARGET
#                  DENYLIST active (block target package/repo, allow deps); egress → egress.log.
#                  → run/rebuild/ + transcripts/rebuild.jsonl + egress.log
#   Evaluator    : framework/evaluate.sh → run/score/scorecard.json (+ evidence)
#   Leakage audit: framework/leakage-audit.mjs over egress.log + rebuild.jsonl → INVALIDATED
#                  runs are discarded and RE-RUN (not counted toward N).
#
# Usage: framework/run.sh <target> [--runs N] [--max-attempts M]
set -euo pipefail
LIB_TAG=run
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$EVAL_ROOT/harness/lib.sh"
require_cmd docker node claude git

TARGET="${1:?usage: framework/run.sh <target> [--runs N] [--max-attempts M]}"; shift
N=5; MAX_ATTEMPTS=$((N * 2))
while [ $# -gt 0 ]; do case "$1" in
  --runs) N="$2"; MAX_ATTEMPTS=$((N * 2)); shift 2;;
  --max-attempts) MAX_ATTEMPTS="$2"; shift 2;;
  *) abort "unknown arg: $1";;
esac; done

RESOLVED="$(node "$FW_DIR/dispatch.mjs" "$TARGET" --json)" || abort "dispatch failed"
TMP=$(mktemp); printf '%s\n' "$RESOLVED" > "$TMP"
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))' "$TMP" "$1"; }
[ "$(jget runner.id)" = "docker" ] || abort "run.sh is the docker lane; manifest selects '$(jget runner.id)'"
IMAGE=$(jget environment.image); SHA=$(jget source.sha)
EVAL_DIR="$EVAL_ROOT/evals/$TARGET"; SOURCE_DIR="$EVAL_DIR/source"; RUNS="$EVAL_DIR/runs"
SKILL_REPO="${SEED_CREATE_REPO:-/Users/plucas/cncorp/skill-seed-create}"
# Denylist (published target): block the target PACKAGE (registry) + the target REPO PATH —
# NOT the whole repo host. A shared code host (github.com/gitlab.com/…) also serves legit
# deps, so host-level blocking would deny those too. For a shared host we deny only the
# package live and catch a target-repo CLONE post-hoc via the transcript repo-PATH audit;
# DENY_HOST is used only when the target lives on its OWN dedicated host.
DENY_PACKAGE="$TARGET"
TARGET_REPO=$(jget source.repo)
REPO_HOST=$(node -e 'try{const u=new URL(process.argv[1]);process.stdout.write(u.hostname)}catch(e){}' "$TARGET_REPO")
SHARED_HOSTS=" github.com gitlab.com bitbucket.org codeload.github.com raw.githubusercontent.com "
case "$SHARED_HOSTS" in *" $REPO_HOST "*) DENY_HOST="" ;; *) DENY_HOST="$REPO_HOST" ;; esac

# ---- Setup (once) ----------------------------------------------------------
[ -f "$EVAL_DIR/oracle/setup.json" ] && [ "$(node -e 'try{process.stdout.write(require(process.argv[1]).status)}catch(e){process.stdout.write("none")}' "$EVAL_DIR/oracle/setup.json")" = "green" ] \
  || { log "Setup not green — running framework/setup.sh ..."; bash "$FW_DIR/setup.sh" "$TARGET"; }
log "Setup green. target=$TARGET image=$IMAGE deny-package=$DENY_PACKAGE deny-host=${DENY_HOST:-（none)}"

PORT=8910
PROXY_HOST="host.docker.internal"

# one full attempt → returns 0 if VALID (not leaked), 8 if INVALIDATED, 1 on hard error
one_run() {
  local label="$1" RUN_DIR="$RUNS/$label"
  saferm "$RUN_DIR" "$RUNS" 2>/dev/null || true
  mkdir -p "$RUN_DIR/seed" "$RUN_DIR/rebuild" "$RUN_DIR/transcripts"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local egress="$RUN_DIR/egress.log"; : > "$egress"
  local capEgress="$RUN_DIR/capture-egress.log"; : > "$capEgress"

  # ---------- Seed Creator (net-on; full source/) ----------
  log "[$label] Seed Creator: capturing seed from full source (net-on) ..."
  local CW="$RUN_DIR/.creator-ws"; saferm "$CW" "$RUN_DIR" 2>/dev/null || true; mkdir -p "$CW"
  ( cd "$SOURCE_DIR" && tar --exclude=node_modules --exclude=.git --exclude='.setup-*' -cf - . ) | ( cd "$CW" && tar -xf - )
  bash "$FW_DIR/stage-agent.sh" creator "$label" "$CW" "$IMAGE" "$capEgress" "$PORT" \
    --skill-repo "$SKILL_REPO" --seed-out "$RUN_DIR/seed" --transcript "$RUN_DIR/transcripts/capture.jsonl" \
    || abort "[$label] Seed Creator failed"

  # ---------- Seed Installer (net-on; SEED ONLY; denylist active) ----------
  log "[$label] Seed Installer: rebuilding from the seed alone (net-on, denylist active) ..."
  local IW="$RUN_DIR/.installer-ws"; saferm "$IW" "$RUN_DIR" 2>/dev/null || true; mkdir -p "$IW"
  cp -R "$RUN_DIR/seed/." "$IW/"
  find "$IW" -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true
  node "$EVAL_ROOT/harness/strip-seed-source.mjs" "$IW" "$RUN_DIR" >/dev/null 2>&1 || abort "[$label] seed source-strip failed (installer must get seed-only)"
  bash "$FW_DIR/stage-agent.sh" installer "$label" "$IW" "$IMAGE" "$egress" "$PORT" \
    --transcript "$RUN_DIR/transcripts/rebuild.jsonl" --rebuild-out "$RUN_DIR/rebuild" \
    --deny-package "$DENY_PACKAGE" --deny-host "$DENY_HOST" \
    || log "[$label] installer agent exited non-zero (a failed build is an honest outcome; scoring will reflect it)"

  # ---------- Evaluator ----------
  log "[$label] Evaluator: scoring the install ..."
  if [ -d "$RUN_DIR/rebuild/src" ]; then
    bash "$FW_DIR/evaluate.sh" "$TARGET" --rebuild "$RUN_DIR/rebuild" --seed "$RUN_DIR/seed" --label "$label" || log "[$label] evaluate returned non-zero"
  else
    log "[$label] no rebuilt src/ — emitting a build-failed scorecard"
    mkdir -p "$RUN_DIR/score/evidence"
    node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({schemaVersion:2,target:process.argv[2],label:process.argv[3],buildOk:false,composite:{score:0,weightPresent:0,note:"installer produced no ./src — nothing to build/score; composite 0 (honest failed-run trend contribution).",components:[]},breakdown:{build:{ok:false}},harness:[],dimension1_fidelity:{},dimension2_seedQuality:{}},null,2)+"\n")' "$RUN_DIR/score/scorecard.json" "$TARGET" "$label"
  fi

  # ---------- Leakage audit (post-hoc, invalidating) ----------
  # one_run executes under the loop's `set +e` (errexit OFF). Keep it off here and capture
  # the audit exit with `|| arc=$?` — an INVALIDATED (exit 8) return must propagate to the
  # loop as DATA (→ discard + re-run), NOT trip errexit. (A prior `set -e` here leaked
  # errexit back on, so the non-zero `return $arc` aborted the ENTIRE sweep after one
  # INVALIDATED run instead of retrying.)
  log "[$label] Leakage audit ..."
  local arc=0
  node "$FW_DIR/leakage-audit.mjs" "$egress" "$RUN_DIR/transcripts/rebuild.jsonl" "$RUN_DIR/score/leakage-audit.json" \
    --target-package "$DENY_PACKAGE" --target-host "$DENY_HOST" --target-repo "$TARGET_REPO" || arc=$?

  # ---------- run.json ----------
  node -e 'const fs=require("fs");const sc=(()=>{try{return require(process.argv[3])}catch(e){return null}})();const la=(()=>{try{return require(process.argv[4])}catch(e){return null}})();fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,label:process.argv[2],target:process.argv[5],timestamp:process.argv[6],environment:{type:"docker",image:process.argv[7]},sha:process.argv[8],status:la&&la.verdict==="INVALIDATED"?"invalidated":"complete",leakageVerdict:la?la.verdict:"not-audited",scores:sc&&sc.composite?{composite:sc.composite.score,ourCriteria:(sc.breakdown&&sc.breakdown.ourCriteria)?sc.breakdown.ourCriteria.passed+"/"+sc.breakdown.ourCriteria.N:null,projectTests:(sc.breakdown&&sc.breakdown.projectTests)?sc.breakdown.projectTests.passed+"/"+sc.breakdown.projectTests.M:null}:null,outputs:{seed:"seed/",rebuild:"rebuild/",transcripts:"transcripts/",egress:"egress.log",score:"score/"}},null,2)+"\n")' \
    "$RUN_DIR/run.json" "$label" "$RUN_DIR/score/scorecard.json" "$RUN_DIR/score/leakage-audit.json" "$TARGET" "$ts" "$IMAGE" "$SHA"

  saferm "$CW" "$RUN_DIR" 2>/dev/null || true; saferm "$IW" "$RUN_DIR" 2>/dev/null || true
  rm -rf "$RUN_DIR/rebuild/node_modules" 2>/dev/null || true
  return $arc
}

# ---- the multi-run loop (INVALIDATED → re-run, not counted toward N) --------
valid=0; attempt=0
while [ "$valid" -lt "$N" ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  label=$(printf 'run-%02d' "$attempt")
  log "===== attempt $attempt (valid so far: $valid/$N) → $label ====="
  set +e; one_run "$label"; rc=$?; set -e
  if [ "$rc" -eq 8 ]; then
    log "===== $label INVALIDATED by leakage audit → discarding + re-running (not counted) ====="
  else
    valid=$((valid + 1))
    log "===== $label VALID ($valid/$N) ====="
  fi
done

log "aggregating runs/index.json over $valid valid run(s) ..."
node "$FW_DIR/aggregate-index.mjs" "$RUNS"
rm -f "$TMP"
[ "$valid" -ge "$N" ] && log "DONE: $valid valid run(s); index at $RUNS/index.json" || abort "exhausted $MAX_ATTEMPTS attempts with only $valid/$N valid runs"
