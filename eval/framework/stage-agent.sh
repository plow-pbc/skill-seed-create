#!/usr/bin/env bash
# One agent stage (Seed Creator or Seed Installer) — NETWORK-ON agent (Chunk 4).
#
# Starts the egress proxy (logging; denylist for the installer), runs a confined
# `claude -p` agent against a net-on container routed through the proxy, and collects
# the stage output. Confinement is the FIXED agent-tool-guard (file tools → the single
# workspace; Bash → one `docker exec` into this stage's container). Network is ON via
# the proxy — blindness is by workspace contents + the post-hoc leakage audit, not net-off.
#
# Usage:
#   stage-agent.sh creator   <label> <workspace> <image> <egressLog> <port> \
#       --skill-repo <dir> --seed-out <dir> --transcript <file>
#   stage-agent.sh installer <label> <workspace> <image> <egressLog> <port> \
#       --transcript <file> --rebuild-out <dir> --deny-package <p> --deny-host <h>
set -euo pipefail
LIB_TAG=stage-agent
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$EVAL_ROOT/harness/lib.sh"

ROLE="$1"; LABEL="$2"; WS="$3"; IMAGE="$4"; EGRESS="$5"; PORT="$6"; shift 6
WS=$(cd "$WS" && pwd)
SKILL_REPO=""; SEED_OUT=""; REBUILD_OUT=""; TRANSCRIPT=""; DENY_PACKAGE=""; DENY_HOST=""
while [ $# -gt 0 ]; do case "$1" in
  --skill-repo) SKILL_REPO="$2"; shift 2;; --seed-out) SEED_OUT="$2"; shift 2;;
  --rebuild-out) REBUILD_OUT="$2"; shift 2;; --transcript) TRANSCRIPT="$2"; shift 2;;
  --deny-package) DENY_PACKAGE="$2"; shift 2;; --deny-host) DENY_HOST="$2"; shift 2;;
  *) abort "unknown arg: $1";; esac; done

CONTAINER="agent-${ROLE}-${LABEL}-$$"
AGENT_DIR="$WS/.agent"; mkdir -p "$AGENT_DIR"
PROXY_HOST="host.docker.internal"

# ---- start the egress proxy (logging; denylist only for the installer) ------
DENY_ARGS=()
[ -n "$DENY_PACKAGE" ] && DENY_ARGS+=(--deny-package "$DENY_PACKAGE")
[ -n "$DENY_HOST" ] && DENY_ARGS+=(--deny-host "$DENY_HOST")
# NOTE empty-array expansion: bash 3.2 (macOS) treats "${arr[@]}" of an EMPTY array as an
# unbound variable under `set -u` → aborts. Use ${arr[@]+"${arr[@]}"} so an empty DENY_ARGS
# expands to nothing instead of killing the (backgrounded) proxy launch.
node "$FW_DIR/egress-proxy.mjs" --port "$PORT" --log "$EGRESS" ${DENY_ARGS[@]+"${DENY_ARGS[@]}"} > "$AGENT_DIR/proxy.out" 2>&1 &
PROXY_PID=$!
cleanup() { kill -TERM "$PROXY_PID" 2>/dev/null || true; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 1 30); do grep -q PROXY-READY "$AGENT_DIR/proxy.out" && break; sleep 0.3; done
log "[$LABEL/$ROLE] egress proxy on :$PORT (deny: pkg=${DENY_PACKAGE:-none} host=${DENY_HOST:-none}) → $EGRESS"

# ---- net-ON container routed through the proxy ------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Route ALL proxy-aware egress through the logging proxy: set the full env-var matrix
# (curl/wget/git/node-fetch/npm all honor these) so HTTP(S) egress is logged, not just npm.
# Residual (recorded in the leakage audit): a raw-socket client that ignores *_PROXY and
# talks straight to the bridge gateway still bypasses logging — caught post-hoc by the
# transcript audit + the registry-tunnel deny, not at the host level.
PROXY_URL="http://${PROXY_HOST}:${PORT}"
docker run -d --name "$CONTAINER" \
  -e HTTPS_PROXY="$PROXY_URL" -e HTTP_PROXY="$PROXY_URL" -e ALL_PROXY="$PROXY_URL" \
  -e https_proxy="$PROXY_URL" -e http_proxy="$PROXY_URL" -e all_proxy="$PROXY_URL" \
  -e npm_config_registry="${PROXY_URL}/" \
  -e GIT_TERMINAL_PROMPT=0 \
  -v "$WS:/work" -w /work "$IMAGE" sleep infinity > "$AGENT_DIR/container.id"
# route git through the proxy too (so target-repo fetches are logged + denied)
docker exec "$CONTAINER" sh -lc "git config --global http.proxy http://${PROXY_HOST}:${PORT} 2>/dev/null || true"
log "[$LABEL/$ROLE] container $CONTAINER up (net-on, proxied)"

# ---- the confinement settings (FIXED agent-tool-guard) -----------------------
GUARD="$EVAL_ROOT/harness/agent-tool-guard.mjs"
cat > "$AGENT_DIR/settings.json" <<JSON
{
  "enabledPlugins": { "superpowers@superpowers-marketplace": false },
  "hooks": { "PreToolUse": [ { "matcher": "*",
    "hooks": [ { "type": "command", "command": "AGENT_WORKSPACE='$WS' AGENT_CAPTURE_CONTAINER='$CONTAINER' AGENT_ALLOW_READ='${SKILL_REPO}' node '$GUARD'" } ] } ] }
}
JSON

# ---- role-specific prompt + plugin --------------------------------------------
PLUGIN_ARGS=()
if [ "$ROLE" = "creator" ]; then
  PLUGIN_DIR="$AGENT_DIR/evalseed-plugin"; mkdir -p "$PLUGIN_DIR/.claude-plugin" "$PLUGIN_DIR/skills"
  ln -sfn "$SKILL_REPO" "$PLUGIN_DIR/skills/seed-create"
  cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" <<JSON
{ "name": "evalseed", "version": "0.0.1", "description": "eval-isolated repo seed-create", "skills": ["./skills/seed-create"] }
JSON
  PLUGIN_ARGS=(--plugin-dir "$PLUGIN_DIR")
  cat > "$AGENT_DIR/interview.md" <<'MD'
CAPABILITY: the software in your working directory (read its README, source, examples).
SEED_NAME: the project's name. WORKSPACE: here. PUBLISH: local-only.
STATE_TO_WIPE: scratch build dirs only. HUMAN_STEPS: (none). MAX_ITERS: 0 (stop at DRAFT).
MD
  PROMPT="You are the SEED CREATOR for an eval of seed-create. Study the FULL project in your CURRENT WORKING DIRECTORY (README, source, examples — you have all of it, as a real seed-create user does). Then run the **evalseed:seed-create** skill (the repo version, via plugin) to capture this capability as a SEED, answering its interview yourself from the FIXED CONTRACT below, and STOP at SEEDCREATE_RESULT=DRAFT. Write the seed with Write into ./seed-output/ (e.g. ./seed-output/<name>.seed.md). Do NOT git-init it. Remember the discipline: extract the ESSENCE into prose, do not dump source.
FIXED INTERVIEW CONTRACT:
$(cat "$AGENT_DIR/interview.md")
HARD RULES (a hook enforces these): file tools work only inside this working dir; Bash is ONE 'docker exec $CONTAINER sh -lc \"...\"' (network is ON inside it). Stop at SEEDCREATE_RESULT=DRAFT.
Begin."
  APPEND="You are the SEED CREATOR. You have the full source/ in your working dir. Author the seed via Write into ./seed-output/. Bash is confined to 'docker exec $CONTAINER sh -lc ...' (net-on). Use evalseed:seed-create. Stop at SEEDCREATE_RESULT=DRAFT."
  TIMEOUT=1200
else
  PROMPT="You are the SEED INSTALLER for an eval. Your working directory holds ONLY a SEED (a <name>.seed.md, plus maybe README/scripts) — NO source, NO tests. Build the described software FROM THE SEED ALONE: reconstruct the source under ./src/ and produce a working build (./dist or ./build) by following the seed. Install dependencies with npm as needed (network is ON inside your container). Do NOT fetch the target project itself (no npm install of the target, no git clone of its repo) — only its dependencies. When done, print REBUILD_COMPLETE.
HARD RULES (a hook enforces these): file tools work only inside this working dir; Bash is ONE 'docker exec $CONTAINER sh -lc \"...\"' (net-on, routed through a logging+denylist proxy). A failed build is an acceptable honest outcome — do not fetch the target to fake it.
Begin."
  APPEND="You are the blind SEED INSTALLER. You have ONLY the seed — never the source/tests. Reconstruct ./src/ and build from the seed alone. Bash is confined to 'docker exec $CONTAINER sh -lc ...' (net-on; deps OK, the target itself is denylisted). Stop at REBUILD_COMPLETE."
  TIMEOUT=1500
fi

# ---- run the agent -----------------------------------------------------------
log "[$LABEL/$ROLE] running claude -p (timeout ${TIMEOUT}s) ..."
set +e
( cd "$WS" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 timeout "$TIMEOUT" claude -p "$PROMPT" \
    --append-system-prompt "$APPEND" \
    ${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"} \
    --no-session-persistence \
    --allowedTools "Skill" "Bash" "Read" "Glob" "Grep" "Write" "Edit" "TodoWrite" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" "Task" "AskUserQuestion" "NotebookEdit" \
    --settings "$AGENT_DIR/settings.json" \
    --max-turns 200 \
    --output-format stream-json --verbose --include-partial-messages \
    < /dev/null ) > "$TRANSCRIPT" 2> "$AGENT_DIR/stderr.log"
AGENT_RC=$?
set -e
log "[$LABEL/$ROLE] agent exit=$AGENT_RC"

# ---- collect output (host controls git; symlink-safe) -----------------------
# BOTH stages collect via the symlink-safe collector — NO raw-tar fallback (a tar fallback
# would re-open the host<->container symlink seam safe-collect exists to close). A symlink/
# out-of-tree refusal aborts the stage LOUDLY rather than silently degrading to raw tar.
if [ "$ROLE" = "creator" ]; then
  [ -d "$WS/seed-output" ] || abort "[$LABEL] creator produced no ./seed-output/"
  rm -rf "$SEED_OUT"; mkdir -p "$SEED_OUT"
  node "$EVAL_ROOT/harness/safe-collect.mjs" "$WS/seed-output" "$SEED_OUT" --label seed \
    || abort "[$LABEL] safe-collect refused the seed output (symlink/out-of-tree) — NOT falling back to raw tar"
  [ -n "$(find "$SEED_OUT" -name '*.seed.md' -o -name 'SEED.md' 2>/dev/null | head -1)" ] || abort "[$LABEL] no seed file collected"
  log "[$LABEL/creator] seed collected → $SEED_OUT"
else
  rm -rf "$REBUILD_OUT"; mkdir -p "$REBUILD_OUT"
  node "$EVAL_ROOT/harness/safe-collect.mjs" "$WS" "$REBUILD_OUT" --exclude node_modules,.git,.agent --label rebuild \
    || abort "[$LABEL] safe-collect refused the rebuilt artifact (symlink/out-of-tree) — NOT falling back to raw tar"
  log "[$LABEL/installer] rebuilt artifact collected → $REBUILD_OUT ($([ -d "$REBUILD_OUT/src" ] && echo 'has src/' || echo 'NO src/'))"
fi
# cleanup runs via trap
