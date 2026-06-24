#!/usr/bin/env bash
# Chunk 3 (part 2) — author-creator cook: run seed-create against the stripped,
# net-off capture container C, answer the FIXED interview contract, STOP at DRAFT.
#
# THREE-AXIS BLINDNESS (review cycle 2):
#  - FILESYSTEM: the cook's file tools (Read/Glob/Grep) are HOOK-confined to the
#    single stripped workspace (cook-tool-guard.mjs, matcher "*"); any escape
#    (absolute path, '..', symlink, the oracle manifest) is DENIED. Proven
#    positively by capture-build-c.sh's blindness-proof.json / fs-blindness.log.
#  - NETWORK: Bash is hook-confined to `docker exec <net-off C>`; Web/Agent/Task
#    withheld. Proven by blocked-egress.log (git clone + npm both blocked).
#  - PRIOR-KNOWLEDGE: this is a SEPARATE FRESH cook. It is given NO manifest, NO
#    test names/counts; its interview answers derive only from non-oracle materials
#    (the contract below). It must NOT be the same cook that built the harness /
#    read config.json. The guard also denies any Read of config.json.
#
# Inference runs via host OAuth (the cook process is on the host); only its TOOLS
# are confined, so it has no path to the target.
#
# IMPORTANT: the hook is wired ONLY into the cook's --settings; it does NOT affect
# this harness shell (we still git/df/prune normally) — scope is proven in the run.
#
# Usage: capture-run-cook.sh [run-id]
set -euo pipefail
LIB_TAG=cook
EVAL_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$EVAL_DIR/harness/lib.sh"
require_cmd claude docker git node

RUN_ID="${1:?usage: capture-run-cook.sh <run-id> [target]}"
TARGET="${2:-oh-my-logo}"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/capture-workspace"
SEED_DIR="$RUN_DIR/seed"
COOK_DIR="$RUN_DIR/cook"
CONTAINER="$(cat "$RUN_DIR/capture-c.name")"

[ -d "$WORKSPACE" ] || abort "no stripped workspace at $WORKSPACE (run capture-build-c.sh first)"
docker inspect "$CONTAINER" >/dev/null 2>&1 || abort "capture container $CONTAINER not running"

# SEED_DIR is the HOST destination — populated AFTER the cook exits by copying the
# cook's in-WORKSPACE seed-output dir out. The cook authors the seed with the Write
# tool (hook-confined to the workspace) rather than a docker-exec heredoc: the fixed
# guard correctly rejects host-level newlines/metachars, so heredoc-via-exec is out.
saferm "$SEED_DIR" "$RUN_DIR" || true; mkdir -p "$SEED_DIR"
saferm "$COOK_DIR" "$RUN_DIR" || true; mkdir -p "$COOK_DIR"

# read carve-out: the cook may READ the seed-create skill's own (oracle-free) docs.
SKILL_READ_ROOT="$(skill_read_root)"
SEED_OUT_REL="seed-output"                 # the cook writes the seed here (inside the workspace)
SEED_OUT_HOST="$WORKSPACE/$SEED_OUT_REL"
saferm "$SEED_OUT_HOST" "$WORKSPACE" || true; mkdir -p "$SEED_OUT_HOST"

# ---- fixed, recorded interview contract (derived ONLY from README/usage/source) ----
cat > "$RUN_DIR/interview-contract.md" <<'CONTRACT'
# Author-creator interview contract — oh-my-logo (FIXED, recorded for reproducibility)

Persona: a developer capturing oh-my-logo's capability as a reproducible SEED for
their own reuse. Answers derived ONLY from non-oracle materials (README, package.json,
src/) — NEVER from the test suite (which is withheld). The cook answers consistently
with this contract plus its own study of the stripped repo.

- CAPABILITY:
  "oh-my-logo renders large ASCII-art logos with colorful gradients in the terminal.
   It ships a CLI (`oh-my-logo <text> [palette] [--filled --block-font <f> --letter-spacing <n>
   --reverse-gradient --palette-colors <list>]`, plus `--list-palettes`) AND a library API
   (e.g. renderLogo / a filled renderer / named palettes) usable from other programs. Two
   render modes — outlined ASCII (figlet) and filled block characters — with 13 named
   gradient palettes, gradient directions, multi-line text, and custom palettes."

- STATE_TO_WIPE (must be absent so a rebuild reproduces from scratch):
  "node_modules/ and dist/ (compiled build output), plus any npm / TypeScript build caches.
   A clean rebuild installs dependencies and compiles from src/."

- HUMAN_STEPS (prerequisites / not fully automatable):
  "Install Node.js >= 18 and npm; use a terminal that supports ANSI truecolor for correct
   gradient rendering. No external accounts, secrets, or network services required."

- PUBLISH CHOICE:
  "Local capture only — initialize the seed as a local git repo. Do NOT publish to npm and
   do NOT push to a remote."

- STOP CONDITION (eval harness override):
  "Run seed-create only up to SEEDCREATE_RESULT=DRAFT. Do NOT run seed-create's harden loop."
CONTRACT

# ---- cook settings: wire the blindness-gate hook (scoped to the cook ONLY) ----
# matcher "*" => the guard runs on EVERY tool call (the prior bug was a Bash-only
# matcher, which let Read/Glob/Grep reach the oracle). The guard confines file
# tools to $WORKSPACE and Bash to docker-exec-into-$CONTAINER; it passes through
# Skill/TodoWrite. Env is inlined here so the hook is self-contained and the
# confinement is scoped to THIS cook's --settings only (no global/project hook).
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

# ---- cook briefing (record only; NOT written into the workspace) ----
# The cook runs with cwd = the stripped workspace so its default Glob/Grep land
# in-workspace. We deliberately do NOT drop a CLAUDE.md into the workspace: the
# target ships its own CLAUDE.md and clobbering it would corrupt the capture. All
# briefing is carried in the prompt + system prompt below; this copy is for audit.
cat > "$COOK_DIR/cook-briefing.md" <<EOF
# Author-creator cook briefing (eval harness, $CONTAINER)
- cwd = the stripped workspace (the target with its test suite withheld).
- File tools (Read/Glob/Grep/Write/Edit) are HOOK-confined to this workspace; escapes denied.
- Author the seed with the Write tool into ./$SEED_OUT_REL/ (SEED.md, README.md, scripts).
- No network / no web/agent tools. Bash is confined to: docker exec $CONTAINER sh -lc '...'
  (workspace mounted at /work, no network). Stop at SEEDCREATE_RESULT=DRAFT.
EOF

PROMPT="You are an autonomous author-creator cook for an eval of the seed-create skill. You are a
FRESH cook: you have never seen this target's test suite, its file inventory, or any manifest, and
you must not try to obtain them.

GOAL: study the software in your CURRENT WORKING DIRECTORY (its README, package.json, and src/ — the
test suite has been withheld and is not present), then run the **seed-create** skill to capture this
capability as a SEED repo, answering seed-create's interview yourself using the FIXED contract below,
and STOP at SEEDCREATE_RESULT=DRAFT.

FIXED INTERVIEW CONTRACT (use these answers; do not ask anyone):
$(cat "$RUN_DIR/interview-contract.md")

HARD RULES (enforced by a blindness-gate hook — violations are denied, not just discouraged):
- STUDY with your file tools: Read/Glob/Grep work, but ONLY within this working directory. Any path
  that escapes it (absolute paths elsewhere, '..', symlinks, the oracle manifest) is DENIED. The test
  suite is not here; do not go looking for it.
- You have NO network and NO web/agent tools. Do NOT git clone or npm install the target.
- WRITE the seed with the Write tool into the ./$SEED_OUT_REL/ directory in your working dir, e.g.
  Write file_path=./$SEED_OUT_REL/SEED.md, ./$SEED_OUT_REL/README.md, ./$SEED_OUT_REL/scripts/*.sh.
  Everything under ./$SEED_OUT_REL/ becomes the seed repo. Do NOT git-init it — the harness does that
  after you exit. (Your file tools are confined to this working dir; that's why the seed lives here.)
- To RUN commands (recon probes, trying the tool), use Bash confined to the OFFLINE container:
    docker exec $CONTAINER sh -lc '<one self-contained script; put all pipes/&&/redirects INSIDE
    these single quotes — host-level ; | & < > and newlines are rejected by the gate>'
  The workspace is mounted at /work inside the container (no network).
- Invoke the seed-create skill and follow its procedure. When it interviews you, answer from the contract.
- STOP at SEEDCREATE_RESULT=DRAFT. Do NOT run seed-create's harden loop. Do NOT publish.
- When done, print a final line exactly: SEEDCREATE_RESULT=DRAFT

Begin."

log "running author-creator cook (headless claude; ALL file+shell access confined to $CONTAINER) ..."
log "transcript -> $RUN_DIR/cook-transcript.jsonl"
set +e
# Read/Glob/Grep/Write/Edit are enabled but HOOK-CONFINED to the stripped workspace
# (file reads can't escape; writes are workspace-only). Bash is hook-confined to a
# SINGLE docker exec into net-off $CONTAINER (host-level metachars/newlines rejected).
# Web*/Agent/Task withheld at launch AND denied by the deny-by-default guard. cwd =
# the workspace so default Glob/Grep land in-workspace; the seed is authored via Write
# into ./$SEED_OUT_REL/ (heredoc-via-exec is intentionally impossible under the gate).
( cd "$WORKSPACE" && timeout 900 claude -p "$PROMPT" \
    --append-system-prompt "You are a FRESH, test-blind author-creator cook. You have never seen this target's tests or any manifest. Your file tools (Read/Glob/Grep/Write/Edit) are confined to your working directory; any escape is denied and writes outside it are denied. You have NO network and NO web/agent tools. Bash is confined to a single 'docker exec $CONTAINER sh -lc ...' (offline; /work=workspace); host-level ; | & < > \$ and newlines are rejected — keep all shell logic inside the single quotes. Author the seed with Write into ./$SEED_OUT_REL/. Never fetch the target. Stop at SEEDCREATE_RESULT=DRAFT." \
    --allowedTools "Skill" "Bash" "Read" "Glob" "Grep" "Write" "Edit" "TodoWrite" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" "Task" "AskUserQuestion" "NotebookEdit" \
    --settings "$COOK_DIR/settings.json" \
    --max-turns 120 \
    --output-format stream-json --verbose --include-partial-messages \
    < /dev/null ) > "$RUN_DIR/cook-transcript.jsonl" 2> "$RUN_DIR/cook-stderr.log"
COOK_RC=$?
set -e
log "cook exit=$COOK_RC"

# ---- extract a readable result + tool log from the stream-json transcript ----
node "$EVAL_DIR/harness/cook-transcript-summarize.mjs" "$RUN_DIR/cook-transcript.jsonl" "$RUN_DIR" cook || true

# ---- VALIDATE the capture — fail LOUDLY, no silent accept (review cycle 2, IMPORTANT 1) ----
# (1) cook process must have exited cleanly
[ "$COOK_RC" -eq 0 ] || abort "cook exited non-zero ($COOK_RC) — capture invalid. See cook-stderr.log / cook-readable.md"

# (2) the cook itself must have emitted SEEDCREATE_RESULT=DRAFT in its FINAL result
#     (not merely echoed in the prompt). Inspect the stream-json `result` event.
DRAFT_OK=$(node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
let res="";
for(const ln of L){let e;try{e=JSON.parse(ln)}catch{continue} if(e.type==="result")res=String(e.result||"");}
process.stdout.write(/SEEDCREATE_RESULT=DRAFT/.test(res)?"yes":"no");
' "$RUN_DIR/cook-transcript.jsonl")
[ "$DRAFT_OK" = "yes" ] || abort "cook did not emit SEEDCREATE_RESULT=DRAFT in its final result — capture invalid (did it stop early or run the harden loop?)."

# (3) the cook must have actually written a seed
[ -n "$(ls -A "$SEED_OUT_HOST" 2>/dev/null)" ] || abort "no seed written under $SEED_OUT_HOST — capture invalid."

# (4) FREEZE the container BEFORE collection (Chunk-4 fix #2 CRITICAL / TOCTOU): the
#     workspace is mounted into C, so a cook-launched background process could swap a
#     seed file -> symlink between the host walk and copy. Stopping C kills ALL
#     in-container processes => no live mutation window. safe-collect then opens with
#     O_NOFOLLOW as belt+suspenders. (The cook is done; C is no longer needed.)
log "freezing container $CONTAINER before seed collection (no live mutation window) ..."
docker stop -t 2 "$CONTAINER" >/dev/null 2>&1 || true

# (5) HOST CONTROLS GIT (final-pass IMPORTANT): a cook could plant a .git/ (fake
#     history, malicious hooks) in seed-output. Strip ANY cook-created .git BEFORE
#     collection so the host always re-inits and commits — never trust cook git state.
find "$SEED_OUT_HOST" -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true

# ---- harness finalize: SAFE-COLLECT the seed out, then git-init ----------------
# The shared safe-collect helper REFUSES any symlink (the cook can't `ln -s` the
# oracle into its output and have the host deref it), copies no-deref, asserts every
# entry resolves in-tree, and records a manifest that includes symlinks. Same helper
# guards the rebuilt-artifact seam (capture-run-rebuild.sh).
log "safe-collecting seed $SEED_OUT_HOST -> $SEED_DIR ..."
node "$EVAL_DIR/harness/safe-collect.mjs" "$SEED_OUT_HOST" "$SEED_DIR" \
  --manifest "$RUN_DIR/seed-collect.json" --label seed \
  || abort "seed safe-collect FAILED (symlink/out-of-tree) — capture invalid. See seed-collect.json"
[ -f "$SEED_DIR/SEED.md" ]   || abort "seed has no SEED.md — capture invalid."
[ -f "$SEED_DIR/README.md" ] || abort "seed has no README.md — a SEED repo requires both SEED.md and README.md."

# git-init the seed (local, no network) — the HOST ALWAYS controls git (any cook .git
# was stripped above); fail loudly if it can't be committed.
git -C "$SEED_DIR" init -q || abort "git init of seed failed"
git -C "$SEED_DIR" add -A || abort "git add of seed failed"
git -C "$SEED_DIR" -c user.name="eval-harness" -c user.email="eval@local" \
  commit -q -m "seed-create DRAFT (author-creator cook, $TARGET)" || abort "git commit of seed failed"

echo "=== seed repo file list ($SEED_DIR) ==="
( cd "$SEED_DIR" && find . -type f -not -path './.git/*' | sort )
log "capture VALID: cook clean exit, DRAFT emitted, seed committed. artifacts under $RUN_DIR"
