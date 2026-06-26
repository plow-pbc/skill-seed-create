#!/usr/bin/env bash
# Shared helpers for the macos-vm runner (Chunk 5, §8). Sourced by setup-macos.sh /
# run-macos.sh / stage-cook-macos.sh / evaluate-macos.sh. These run ON THE HOST (neo);
# the host drives a headless macOS GUEST over SSH (the `ssh-to-guest` envHandle).
#
# Engine: Tart. We launch with PLAIN NAT + nohup + caffeinate (NOT `neo-vm run`, which
# uses --net-softnet → `tart ip` returns nothing, and is not nohup'd → dies with the SSH
# session). This is the proven eval-VM launch path (neo-vm-proof/INDEX.md, TURNKEY note).
# Keychain is unlocked IN-SESSION before each launch (macOS 15+ requirement).
#
# No side effects on source. Requires: tart, rsync, ssh, node, caffeinate, security.

: "${MVM_TAG:=mvm}"
mlog()   { echo "[$MVM_TAG] $*" >&2; }
mabort() { echo "" >&2; echo "[$MVM_TAG] ABORT: $*" >&2; echo "" >&2; exit 1; }

GUEST_USER="${NEO_GUEST_USER:-admin}"
GUEST_KEY="${NEO_GUEST_KEY:-$HOME/.ssh/neo_guest_ed25519}"
KEYCHAIN_PW_FILE="${NEO_KEYCHAIN_PW_FILE:-$HOME/.neo_kc_pw}"
GUEST_CPU="${MVM_CPU:-2}"
GUEST_MEM="${MVM_MEM:-4096}"   # megabytes

# Common SSH flags for talking to a freshly-cloned guest (IP may be reused across clones,
# so do not pin host keys). `-n` redirects stdin from /dev/null so an ssh inside a
# `while read` loop cannot swallow the loop's input (we never pipe stdin to the guest).
_mvm_ssh() { ssh -n -i "$GUEST_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes -o ConnectTimeout=8 "$@"; }

mvm_require() {
  local c; for c in tart rsync ssh node caffeinate security; do
    command -v "$c" >/dev/null 2>&1 || mabort "required command not found on host: $c"; done
}

# Portable timeout: macOS ships no GNU `timeout`/`gtimeout`. Prefer them if present, else
# use a background watchdog. Usage: mtimeout <secs> <cmd...>  (returns the cmd's rc, or 124).
mtimeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@" & local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 2; kill -KILL "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill -TERM "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return "$rc"
}

mvm_keychain_unlock() {
  [ -r "$KEYCHAIN_PW_FILE" ] || mabort "keychain password file not readable: $KEYCHAIN_PW_FILE (NEO_KEYCHAIN_PW_FILE)"
  security unlock-keychain -p "$(cat "$KEYCHAIN_PW_FILE")" login.keychain-db \
    || mabort "keychain unlock failed (Virtualization.framework will refuse to launch the VM)"
  security show-keychain-info login.keychain-db >/dev/null 2>&1 \
    || mabort "login.keychain still LOCKED after unlock — cannot launch a VM (macOS 15+ rule)"
}

# mvm_clone <golden> <vm>  — delete a stale clone, CoW-clone a fresh one.
mvm_clone() {
  local golden="$1" vm="$2"
  tart stop "$vm" >/dev/null 2>&1 || true
  tart delete "$vm" >/dev/null 2>&1 || true
  tart clone "$golden" "$vm" || mabort "tart clone $golden -> $vm failed"
  mlog "cloned $golden -> $vm"
}

# mvm_boot <vm>  — plain-NAT headless launch (keychain-unlock in this same shell first).
mvm_boot() {
  local vm="$1"
  mvm_keychain_unlock
  tart set "$vm" --cpu "$GUEST_CPU" --memory "$GUEST_MEM" || mabort "tart set $vm failed"
  # PLAIN NAT (no --net-softnet) so `tart ip` works; nohup+caffeinate so it outlives this shell.
  nohup caffeinate -s tart run --no-graphics "$vm" > "/tmp/mvm-$vm.log" 2>&1 &
  mlog "booted $vm (plain NAT, headless, cpu=$GUEST_CPU mem=${GUEST_MEM}MB) → /tmp/mvm-$vm.log"
}

mvm_ip() { tart ip "$1" 2>/dev/null; }

# mvm_wait_ssh <vm> [timeout]  — block until the guest has an IP and SSH answers. Echoes the IP.
mvm_wait_ssh() {
  local vm="$1" to="${2:-180}" t=0 ip=""
  while [ "$t" -lt "$to" ]; do
    ip="$(mvm_ip "$vm")"
    if [ -n "$ip" ] && _mvm_ssh "$GUEST_USER@$ip" 'echo ready' >/dev/null 2>&1; then
      echo "$ip"; return 0
    fi
    sleep 3; t=$((t + 3))
  done
  mabort "wait-ssh: $vm not reachable within ${to}s (last ip='${ip:-none}')"
}

# mvm_gexec <ip> <command-string>  — run a command in the guest (single string, runs via the guest shell).
mvm_gexec() { local ip="$1"; shift; _mvm_ssh "$GUEST_USER@$ip" "$*"; }

# mvm_gpush <ip> <local-dir-or-file> <guest-path>  /  mvm_gpull reverse. Retried — a
# freshly-booted guest under load occasionally drops the first SSH ("Connection closed").
_mvm_rsh="ssh -i $GUEST_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5"
mvm_gpush() {
  local i; for i in 1 2 3 4; do
    rsync -az --delete -e "$_mvm_rsh" "$2" "$GUEST_USER@$1:$3" && return 0
    mlog "push attempt $i failed ($2 -> $3); retrying in 4s ..."; sleep 4
  done
  mabort "push to guest failed after retries: $2 -> $3"
}
mvm_gpull() {
  mkdir -p "$(dirname "$3")"
  local i; for i in 1 2 3 4; do
    rsync -az -e "$_mvm_rsh" "$GUEST_USER@$1:$2" "$3" && return 0
    mlog "pull attempt $i failed ($2 -> $3); retrying in 4s ..."; sleep 4
  done
  mabort "pull from guest failed after retries: $2 -> $3"
}

# mvm_gcapture <ip> <dst.png on host>  — guest-side screencapture, pulled to the host.
mvm_gcapture() {
  mvm_gexec "$1" 'screencapture -x /tmp/mvm-shot.png' >/dev/null 2>&1 || return 1
  mvm_gpull "$1" /tmp/mvm-shot.png "$2"
}

# mvm_gateway <guest-ip>  — the vmnet gateway (host side) the guest reaches the host on
# (Apple VZ NAT: gateway is .1 of the guest's /24). Egress proxy binds here.
mvm_gateway() { echo "$1" | sed 's/\.[0-9][0-9]*$/.1/'; }

mvm_stop()   { tart stop "$1"   >/dev/null 2>&1 || true; }
mvm_delete() { tart stop "$1" >/dev/null 2>&1 || true; tart delete "$1" >/dev/null 2>&1 || true; mlog "deleted $1"; }

# mvm_strip_oracle <ip>  — DEFENSE: the gui-ready-audio golden bakes the dampe oracle kit at
# ~/dampe-oracle (Chunk-6 scoring material). It must NEVER be visible to a blind installer.
# Remove any baked oracle material from the guest before any agent touches it. Idempotent.
# NOTE: the guest login shell is zsh, which ABORTS a command on a non-matching glob
# (nomatch). So we use `find` (its `-iname` pattern is quoted → no shell globbing) rather
# than `rm -rf ~/*oracle*` (which silently no-ops the whole rm when nothing matches).
mvm_strip_oracle() {
  local ip="$1"
  mvm_gexec "$ip" 'find "$HOME" -maxdepth 1 -iname "*oracle*" -exec rm -rf {} + 2>/dev/null; echo stripped' >/dev/null 2>&1 || true
}
