#!/usr/bin/env bash
# Shared shell helpers for the eval harness (sourced by baseline.sh, capture.sh, ...).
# No side effects on source beyond defining functions.

# log/abort to stderr with a consistent prefix.
log()   { echo "[$LIB_TAG] $*"; }
abort() { echo "" >&2; echo "[$LIB_TAG] ABORT: $*" >&2; echo "" >&2; exit 1; }
: "${LIB_TAG:=harness}"

# saferm <path> <root>: rm -rf <path>, but ONLY if <path> is non-empty AND a
# strict descendant of <root> (also non-empty). Guards against `rm -rf ""` /
# `rm -rf /` from an unset variable. Flagged in Chunk 2 review.
saferm() {
  local p="${1:-}" root="${2:-}"
  [ -n "$p" ] && [ -n "$root" ] || { echo "saferm: empty arg (p='$p' root='$root')" >&2; return 1; }
  case "$p" in
    "$root"/?*) rm -rf "$p" ;;
    *) echo "saferm: refusing to rm '$p' (not strictly under '$root')" >&2; return 1 ;;
  esac
}

# cfg <config-file> <dot.path>: print a scalar field from a JSON config.
cfg() {
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=c;for(const k of process.argv[2].split("."))v=v&&v[k];process.stdout.write(v==null?"":String(v))' \
    "$1" "$2"
}

# require_cmd <cmd...>: abort if any command is missing.
require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || abort "required command not found: $c"; done
}

# skill_read_root: realpath of the seed-create skill's install dir. The cook is
# READ-allowed here (its own oracle-free docs: SKILL.md/SEED.md/README.md) so it
# can author faithfully; this dir is target-agnostic and holds NO oracle. Empty if
# the skill isn't installed at the standard path.
skill_read_root() {
  node -e "try{console.log(require('fs').realpathSync(require('os').homedir()+'/.claude/skills/seed-create'))}catch(e){}"
}
