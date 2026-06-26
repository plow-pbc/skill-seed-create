#!/usr/bin/env bash
# guest-build seam (Chunk 5) — the ONLY shell the macos-vm Installer cook may invoke
# (pinned by cook-guard-guest.mjs as COOK_GUEST_SEAM). It makes "edit on host, build in
# guest" coherent and routes guest egress through the logging proxy over plain NAT:
#
#   1. rsync the host installer workspace  →  the guest run dir
#   2. run the cook's script IN THE GUEST (cwd = guest run dir), with HTTPS_PROXY/http_proxy
#      pointed at the host egress proxy (plain NAT; the guest reaches the host on the vmnet
#      gateway). git is also routed through the proxy so a target `git clone` is logged/denied.
#   3. rsync the guest run dir back to the host workspace (so .build/ etc. are visible to the
#      Evaluator and collector)
#
# Config comes from the environment (set by stage-cook-macos.sh), so the cook only types:
#       bash <seam> 'swift build -c release'
#
# Required env: GB_IP GB_GUEST_WS GB_HOST_WS GB_USER GB_KEY  (GB_PROXY optional "host:port")
set -uo pipefail

SCRIPT="${1:-}"
[ -n "$SCRIPT" ] || { echo "guest-build: empty script" >&2; exit 2; }
: "${GB_IP:?}"; : "${GB_GUEST_WS:?}"; : "${GB_HOST_WS:?}"; : "${GB_USER:?}"; : "${GB_KEY:?}"

SSH_BASE=(ssh -i "$GB_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=8)
RSH="ssh -i $GB_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=8"

# 1. push host ws -> guest run dir
"${SSH_BASE[@]}" "$GB_USER@$GB_IP" "mkdir -p '$GB_GUEST_WS'" >/dev/null 2>&1
rsync -az --exclude='.cook' --exclude='node_modules' -e "$RSH" "$GB_HOST_WS/" "$GB_USER@$GB_IP:$GB_GUEST_WS/" \
  || { echo "guest-build: push failed" >&2; exit 3; }

# 2. run the script in the guest, egress routed through the host proxy (plain NAT)
PROXY_ENV=""
if [ -n "${GB_PROXY:-}" ]; then
  PROXY_ENV="export HTTPS_PROXY=http://$GB_PROXY http_proxy=http://$GB_PROXY ALL_PROXY=http://$GB_PROXY; git config --global http.proxy http://$GB_PROXY >/dev/null 2>&1 || true;"
fi
"${SSH_BASE[@]}" "$GB_USER@$GB_IP" "cd '$GB_GUEST_WS' && $PROXY_ENV { $SCRIPT ; }"
RC=$?

# 3. pull guest run dir back to the host ws (artifacts: .build/, generated files)
rsync -az -e "$RSH" "$GB_USER@$GB_IP:$GB_GUEST_WS/" "$GB_HOST_WS/" >/dev/null 2>&1 || true

exit $RC
