#!/usr/bin/env bash
# One agent stage for the macos-vm lane (Chunk 5) — the macos analog of stage-cook.sh.
# Runs ON THE HOST (neo). NETWORK-ON; blindness is by workspace contents + the guest-build
# seam + the post-hoc leakage audit (no net-off).
#
#   creator   — runs ON THE HOST, FILE-TOOLS-ONLY (Bash disabled by the guard, so it has no
#               host shell and cannot read the oracle). Reads the full source/ copy, runs
#               evalseed:seed-create (repo skill via --plugin-dir) → the SEED. (A host
#               file-tools-only cook has no shell egress path; the meaningful install egress
#               is the installer's, proxied below.)
#   installer — runs ON THE HOST but BUILDS IN THE GUEST: file tools → the seed-only host
#               workspace; Bash → the pinned guest-build seam (syncs ws→guest, runs in guest
#               over plain NAT through the egress proxy, syncs back). Egress is logged to
#               <egressLog> with the TARGET DENYLIST active.
#
# Usage:
#   stage-cook-macos.sh creator   <label> <host-ws> <egressLog> \
#       --skill-repo <dir> --seed-out <dir> --transcript <file>
#   stage-cook-macos.sh installer <label> <host-ws> <egressLog> \
#       --guest-ip <ip> --guest-ws <path> --proxy <host:port> --port <p> --bin <relbin> \
#       --transcript <file> --rebuild-out <dir> --deny-package <p> --deny-host <h>
set -uo pipefail
MVM_TAG=stage-cook-macos
FW_DIR=$(cd "$(dirname "$0")" && pwd)
EVAL_ROOT=$(cd "$FW_DIR/.." && pwd)
. "$FW_DIR/lib-macos.sh"

ROLE="$1"; LABEL="$2"; WS="$3"; EGRESS="$4"; shift 4
WS=$(cd "$WS" && pwd)
SKILL_REPO=""; SEED_OUT=""; REBUILD_OUT=""; TRANSCRIPT=""; DENY_PACKAGE=""; DENY_HOST=""
GUEST_IP=""; GUEST_WS=""; PROXY=""; PORT=""; BIN=""
while [ $# -gt 0 ]; do case "$1" in
  --skill-repo) SKILL_REPO="$2"; shift 2;; --seed-out) SEED_OUT="$2"; shift 2;;
  --rebuild-out) REBUILD_OUT="$2"; shift 2;; --transcript) TRANSCRIPT="$2"; shift 2;;
  --deny-package) DENY_PACKAGE="$2"; shift 2;; --deny-host) DENY_HOST="$2"; shift 2;;
  --guest-ip) GUEST_IP="$2"; shift 2;; --guest-ws) GUEST_WS="$2"; shift 2;;
  --proxy) PROXY="$2"; shift 2;; --port) PORT="$2"; shift 2;; --bin) BIN="$2"; shift 2;;
  *) mabort "unknown arg: $1";; esac; done

COOK_DIR="$WS/.cook"; mkdir -p "$COOK_DIR"
GUARD="$FW_DIR/cook-guard-guest.mjs"
PROXY_PID=""
cleanup() { [ -n "$PROXY_PID" ] && kill -TERM "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT

# ---- settings.json (PreToolUse confinement hook) --------------------------------
write_settings() { # $1 = extra env prefix for the guard command
  cat > "$COOK_DIR/settings.json" <<JSON
{
  "enabledPlugins": { "superpowers@superpowers-marketplace": false },
  "hooks": { "PreToolUse": [ { "matcher": "*",
    "hooks": [ { "type": "command", "command": "${1} node '$GUARD'" } ] } ] }
}
JSON
}

run_claude() { # $1=prompt $2=append $3=timeout ; extra plugin args in PLUGIN_ARGS[]
  local prompt="$1" append="$2" to="$3"
  mlog "[$LABEL/$ROLE] running claude -p (timeout ${to}s) ..."
  set +e
  ( cd "$WS" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 mtimeout "$to" claude -p "$prompt" \
      --append-system-prompt "$append" \
      ${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"} \
      --no-session-persistence \
      --allowedTools "Skill" "Bash" "Read" "Glob" "Grep" "Write" "Edit" "TodoWrite" \
      --disallowedTools "WebFetch" "WebSearch" "Agent" "Task" "AskUserQuestion" "NotebookEdit" \
      --settings "$COOK_DIR/settings.json" \
      --max-turns 200 \
      --output-format stream-json --verbose --include-partial-messages \
      < /dev/null ) > "$TRANSCRIPT" 2> "$COOK_DIR/stderr.log"
  COOK_RC=$?
  set -e
  mlog "[$LABEL/$ROLE] cook exit=$COOK_RC"
}

# ---- scripted-agent stand-ins (MVM_SCRIPTED_AGENT=1) --------------------------
# Used when `claude` is unauthenticated on the §8 host (neo). They exercise the SAME
# runner plumbing — confinement-guard settings, the guest-build seam, seed-strip,
# collection, transcripts — with deterministic behavior instead of an LLM. The default
# (real claude) path above is unchanged and is the faithful lane; this only swaps the
# agent's "thinking" for a script so the RUNNER can be proven where claude can't log in.
scripted_jsonl() { # $1=role note ; emit a minimal transcript so downstream tooling has one
  printf '%s\n' \
    "{\"type\":\"system\",\"subtype\":\"init\",\"agent\":\"scripted-$ROLE\",\"note\":\"$1\"}" \
    "{\"type\":\"result\",\"subtype\":\"success\",\"agent\":\"scripted-$ROLE\"}" > "$TRANSCRIPT"
}
scripted_creator() {
  mlog "[$LABEL/creator] SCRIPTED stand-in: authoring a prose (essence) seed"
  mkdir -p "$WS/seed-output"
  cat > "$WS/seed-output/greet.seed.md" <<'SEED'
# greet — SEED

A tiny macOS command-line tool, built with the Swift Package Manager, that prints a
friendly greeting. The essence (describe-don't-dump):

## What it does (the product contract)
- Run with no arguments, it greets the world: it prints `Hello, world!` and exits 0.
- Given one argument (a name), it greets that name: `greet Ada` prints `Hello, Ada!`.
- The `--version` flag prints `greet 1.0.0` and exits 0.
- Any other argument that begins with `--` is an unknown option: it writes a short error
  to standard error and exits non-zero.

## How it's built
- A SwiftPM executable package named `greet` with a single executable target, sources
  under `Sources/greet/`. Tools version 5.7 is sufficient.
- The program is a few lines of straight-line logic over `CommandLine.arguments` (drop the
  program name): check for `--version` first, then reject other `--`-prefixed options to
  stderr, otherwise treat the first argument (or `world`) as the name and print the greeting.
- No third-party dependencies. Build with `swift build -c release`; the binary lands at
  `.build/release/greet`.

## Human steps to reproduce
macOS with the Swift toolchain (Command Line Tools). No network needed to build.
SEED
  scripted_jsonl "authored ./seed-output/greet.seed.md (prose essence, no source dump)"
}
scripted_installer() {
  mlog "[$LABEL/installer] SCRIPTED stand-in: reconstructing ./src from the seed + building in guest"
  mkdir -p "$WS/src/Sources/greet"
  cat > "$WS/src/Package.swift" <<'PKG'
// swift-tools-version:5.7
import PackageDescription
let package = Package(name: "greet", targets: [.executableTarget(name: "greet", path: "Sources/greet")])
PKG
  cat > "$WS/src/Sources/greet/main.swift" <<'SWIFT'
import Foundation
let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--version" { print("greet 1.0.0"); exit(0) }
if let f = args.first, f.hasPrefix("--") {
  FileHandle.standardError.write("greet: unknown option \(f)\n".data(using: .utf8)!); exit(1)
}
let who = args.first ?? "world"
print("Hello, \(who)!")
SWIFT
  # build IN THE GUEST via the pinned seam (the real mechanic: sync→guest build→sync back)
  bash "$SEAM" 'cd src && swift build -c release && .build/release/greet --version' \
    > "$COOK_DIR/scripted-build.log" 2>&1 || mlog "[$LABEL/installer] guest build returned non-zero (see scripted-build.log)"
  scripted_jsonl "reconstructed ./src (SwiftPM) from the seed and built it in the guest via the seam"
}

if [ "$ROLE" = "creator" ]; then
  # FILE-TOOLS-ONLY: no seam → guard denies Bash. ALLOW_READ = the skill repo only.
  write_settings "COOK_WORKSPACE='$WS' COOK_GUEST_SEAM='' COOK_ALLOW_READ='${SKILL_REPO}'"
  PLUGIN_DIR="$COOK_DIR/evalseed-plugin"; mkdir -p "$PLUGIN_DIR/.claude-plugin" "$PLUGIN_DIR/skills"
  ln -sfn "$SKILL_REPO" "$PLUGIN_DIR/skills/seed-create"
  cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" <<JSON
{ "name": "evalseed", "version": "0.0.1", "description": "eval-isolated repo seed-create", "skills": ["./skills/seed-create"] }
JSON
  PLUGIN_ARGS=(--plugin-dir "$PLUGIN_DIR")
  mkdir -p "$WS/seed-output"
  PROMPT="You are the SEED CREATOR for an eval of seed-create on the macOS lane. Study the FULL project in your CURRENT WORKING DIRECTORY (README, Package.swift, Sources/, scripts/ — you have all of it, as a real seed-create user does). Then run the **evalseed:seed-create** skill (the repo version, via plugin) to capture this capability as a SEED, answering its interview yourself from the FIXED CONTRACT below, and STOP at SEEDCREATE_RESULT=DRAFT. Write the seed with Write into ./seed-output/ (e.g. ./seed-output/<project-name>.seed.md). Do NOT git-init it. Extract the ESSENCE into prose — describe what the software does (the user-visible behavior) and how it is built/run; do NOT dump the source verbatim.
FIXED INTERVIEW CONTRACT:
CAPABILITY: the software in your working directory (read its README, Package.swift, Sources/, scripts/). SEED_NAME: the project's own name. WORKSPACE: here. PUBLISH: local-only. STATE_TO_WIPE: build outputs only (.build / *.app). HUMAN_STEPS: macOS + the Swift toolchain (Command Line Tools) + any permissions the README notes. MAX_ITERS: 0 (stop at DRAFT).
HARD RULES (a hook enforces these): you have NO shell — use Read/Glob/Grep to study and Write/Edit to author the seed into ./seed-output/. Stop at SEEDCREATE_RESULT=DRAFT.
Begin."
  APPEND="You are the SEED CREATOR (macOS lane). File-tools only (no shell). Read the full source in your working dir; author a prose seed via Write into ./seed-output/<project-name>.seed.md using evalseed:seed-create. Extract essence (user-visible behavior + how it's built/run), do not dump source. Stop at SEEDCREATE_RESULT=DRAFT."
  if [ "${MVM_SCRIPTED_AGENT:-0}" = "1" ]; then scripted_creator; else run_claude "$PROMPT" "$APPEND" 1200; fi

  [ -d "$WS/seed-output" ] || mabort "[$LABEL] creator produced no ./seed-output/"
  rm -rf "$SEED_OUT"; mkdir -p "$SEED_OUT"
  ( cd "$WS/seed-output" && tar -cf - . ) | ( cd "$SEED_OUT" && tar -xf - )
  [ -n "$(find "$SEED_OUT" -name '*.seed.md' -o -name 'SEED.md' 2>/dev/null | head -1)" ] || mabort "[$LABEL] no seed file collected"
  mlog "[$LABEL/creator] seed collected → $SEED_OUT"

else
  # ---- installer: start the egress proxy (logging + denylist) ----
  [ -n "$GUEST_IP" ] && [ -n "$GUEST_WS" ] && [ -n "$PORT" ] || mabort "installer needs --guest-ip --guest-ws --port"
  : > "$EGRESS"
  DENY_ARGS=()
  [ -n "$DENY_PACKAGE" ] && DENY_ARGS+=(--deny-package "$DENY_PACKAGE")
  [ -n "$DENY_HOST" ] && DENY_ARGS+=(--deny-host "$DENY_HOST")
  node "$FW_DIR/egress-proxy.mjs" --port "$PORT" --log "$EGRESS" "${DENY_ARGS[@]}" > "$COOK_DIR/proxy.out" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 30); do grep -q PROXY-READY "$COOK_DIR/proxy.out" && break; sleep 0.3; done
  mlog "[$LABEL/installer] egress proxy on :$PORT (deny pkg=${DENY_PACKAGE:-none} host=${DENY_HOST:-none}) → $EGRESS; guest routes via $PROXY"

  # the guest-build seam config (consumed by guest-build.sh; the cook only types `bash <seam> '...'`)
  SEAM="$FW_DIR/guest-build.sh"
  SEAM_ENV="GB_IP='$GUEST_IP' GB_GUEST_WS='$GUEST_WS' GB_HOST_WS='$WS' GB_USER='${NEO_GUEST_USER:-admin}' GB_KEY='$GUEST_KEY' GB_PROXY='$PROXY' COOK_WORKSPACE='$WS' COOK_GUEST_SEAM='$SEAM'"
  # the guard needs COOK_WORKSPACE + COOK_GUEST_SEAM; the seam needs GB_*. Put all in the hook env.
  write_settings "$SEAM_ENV"
  # ALSO export GB_* so the seam (invoked by the cook's Bash) inherits them.
  export GB_IP="$GUEST_IP" GB_GUEST_WS="$GUEST_WS" GB_HOST_WS="$WS" GB_USER="${NEO_GUEST_USER:-admin}" GB_KEY="$GUEST_KEY" GB_PROXY="$PROXY"
  export COOK_GUEST_SEAM="$SEAM" COOK_WORKSPACE="$WS"
  PLUGIN_ARGS=()
  PROMPT="You are the SEED INSTALLER for a macOS eval. Your working directory holds ONLY a SEED (a *.seed.md, plus maybe a README) — NO source, NO tests. Build the described software FROM THE SEED ALONE: reconstruct the whole project under ./src/ (a SwiftPM project — Package.swift + Sources/, and any build script the seed describes such as scripts/build-app.sh) by following the seed, then BUILD it IN THE GUEST.
YOUR ONLY SHELL is the guest-build seam: run    bash $SEAM '<one script>'    — it syncs your ./src workspace into a macOS guest, runs the command THERE, and syncs artifacts back. Put your whole build in ONE single-quoted script per call; do not chain on the host. Use whatever build the seed specifies, e.g.    bash $SEAM 'cd src && swift build -c release'    or    bash $SEAM 'cd src && ./scripts/build-app.sh'   . The built product (a binary or a .app under ./src/.build/) must end up in ./src.
Do NOT fetch the target project itself (no git clone of its repo); only language/toolchain deps if any. A failed build is an acceptable honest outcome — do not fetch the target to fake it. When the build succeeds, print REBUILD_COMPLETE.
Begin."
  APPEND="You are the blind SEED INSTALLER (macOS lane). You have ONLY the seed. Reconstruct the project under ./src/ and BUILD IN THE GUEST via the seam: bash $SEAM '<script>' (use the build the seed describes — swift build or a build script). Never fetch the target. Stop at REBUILD_COMPLETE."
  if [ "${MVM_SCRIPTED_AGENT:-0}" = "1" ]; then scripted_installer; else run_claude "$PROMPT" "$APPEND" 1500; fi

  rm -rf "$REBUILD_OUT"; mkdir -p "$REBUILD_OUT"
  # Collect reconstructed SOURCE only — exclude .build (105 MB of SwiftPM module cache with
  # absolute paths that break a fresh build elsewhere; the Evaluator rebuilds from source).
  ( cd "$WS" && tar --exclude=.cook --exclude='.build' --exclude='*/.build' -cf - . ) | ( cd "$REBUILD_OUT" && tar -xf - )
  # Preserve the built artifact (the §5 rebuild/build/) — just the binary, not the cache.
  if [ -n "$BIN" ] && [ -f "$WS/src/$BIN" ]; then mkdir -p "$REBUILD_OUT/build"; cp "$WS/src/$BIN" "$REBUILD_OUT/build/" 2>/dev/null || true; fi
  mlog "[$LABEL/installer] rebuilt artifact collected → $REBUILD_OUT ($([ -d "$REBUILD_OUT/src" ] && echo 'has src/' || echo 'NO src/'); $([ -f "$REBUILD_OUT/build/$(basename "$BIN")" ] && echo 'built binary present' || echo 'no built binary'))"
fi
