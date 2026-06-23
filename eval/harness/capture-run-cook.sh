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

RUN_ID="${1:?usage: capture-run-cook.sh <run-id>}"
RUN_DIR="$EVAL_DIR/runs/run-$RUN_ID"
WORKSPACE="$RUN_DIR/capture-workspace"
SEED_DIR="$RUN_DIR/seed"
COOK_DIR="$RUN_DIR/cook"
CONTAINER="$(cat "$RUN_DIR/capture-c.name")"

[ -d "$WORKSPACE" ] || abort "no stripped workspace at $WORKSPACE (run capture-build-c.sh first)"
docker inspect "$CONTAINER" >/dev/null 2>&1 || abort "capture container $CONTAINER not running"

saferm "$SEED_DIR" "$RUN_DIR" || true; mkdir -p "$SEED_DIR"
saferm "$COOK_DIR" "$RUN_DIR" || true; mkdir -p "$COOK_DIR"

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
          "command": "COOK_WORKSPACE=$WORKSPACE COOK_CAPTURE_CONTAINER=$CONTAINER node $EVAL_DIR/harness/cook-tool-guard.mjs" } ] }
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
- File tools (Read/Glob/Grep) are HOOK-confined to this workspace; escapes are denied.
- No network / no web/agent tools. Bash is confined to: docker exec $CONTAINER sh -lc '...'
  (workspace mounted at /work; seed output at /seed). Stop at SEEDCREATE_RESULT=DRAFT.
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
- To RUN commands or WRITE the seed, use Bash confined to the OFFLINE container $CONTAINER:
    run:   docker exec $CONTAINER sh -lc '<command>'        (workspace is mounted at /work)
    write: docker exec $CONTAINER sh -lc 'cat > /seed/<file> <<'\"'\"'EOF'\"'\"'
           ...contents...
           EOF'
  Everything under /seed becomes the seed repo (write SEED.md, README.md, and any shell scripts there).
- Invoke the seed-create skill and follow its procedure. When it interviews you, answer from the contract.
- STOP at SEEDCREATE_RESULT=DRAFT. Do NOT run seed-create's harden loop. Do NOT publish.
- When done, print a final line exactly: SEEDCREATE_RESULT=DRAFT

Begin."

log "running author-creator cook (headless claude; ALL file+shell access confined to $CONTAINER) ..."
log "transcript -> $RUN_DIR/cook-transcript.jsonl"
set +e
# Read/Glob/Grep ARE enabled but HOOK-CONFINED to the stripped workspace (the prior
# attempt's break was that they were NOT confined). Bash is hook-confined to docker
# exec into net-off $CONTAINER. Write/Edit/Web*/Agent/Task stay withheld at launch
# (seed is written via docker exec into /seed). cwd = the stripped workspace so the
# cook's default Glob/Grep land in-workspace; escapes are denied by the guard.
( cd "$WORKSPACE" && timeout 900 claude -p "$PROMPT" \
    --append-system-prompt "You are a FRESH, test-blind author-creator cook. You have never seen this target's tests or any manifest. Your file tools (Read/Glob/Grep) are confined to your working directory (the stripped target); any escape is denied. You have NO network and NO web/agent tools. Bash is confined to 'docker exec $CONTAINER' (offline; /work=workspace, /seed=output). Never fetch the target. Stop at SEEDCREATE_RESULT=DRAFT." \
    --allowedTools "Skill" "Bash" "Read" "Glob" "Grep" "TodoWrite" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" "Task" "AskUserQuestion" "Write" "Edit" "NotebookEdit" \
    --settings "$COOK_DIR/settings.json" \
    --max-turns 120 \
    --output-format stream-json --verbose --include-partial-messages \
    < /dev/null ) > "$RUN_DIR/cook-transcript.jsonl" 2> "$RUN_DIR/cook-stderr.log"
COOK_RC=$?
set -e
log "cook exit=$COOK_RC"

# ---- extract a readable result + tool log from the stream-json transcript ----
node "$EVAL_DIR/harness/cook-transcript-summarize.mjs" "$RUN_DIR/cook-transcript.jsonl" "$RUN_DIR" || true

# ---- harness finalize: git-init the seed (local, no network) ----
if [ -n "$(ls -A "$SEED_DIR" 2>/dev/null)" ]; then
  if [ ! -d "$SEED_DIR/.git" ]; then
    git -C "$SEED_DIR" init -q
    git -C "$SEED_DIR" add -A
    git -C "$SEED_DIR" -c user.name="eval-harness" -c user.email="eval@local" commit -q -m "seed-create DRAFT (author-creator cook, oh-my-logo)" || true
  fi
fi

echo "=== seed repo file list ($SEED_DIR) ==="
( cd "$SEED_DIR" && find . -type f -not -path './.git/*' | sort )
echo "=== DRAFT stop marker present in transcript? ==="
grep -o "SEEDCREATE_RESULT=DRAFT" "$RUN_DIR/cook-transcript.jsonl" | head -1 || echo "(marker not found — inspect transcript)"
log "cook done. artifacts under $RUN_DIR"
