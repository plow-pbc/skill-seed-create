#!/usr/bin/env node
// Post-hoc leakage audit (§7). After scoring, check whether the Seed
// Installer fetched THE TARGET ITSELF (the real package/repo — not its deps). A
// leaked run is INVALIDATED (and re-run by the orchestrator). Risk is asymmetric:
// high for a published target with an automated oracle (e.g. fetching the target
// package + re-exporting it would score ~100% fraudulently). Two evidence sources:
//   - egress.log  (network truth): an ALLOWED fetch of the target package/host = leak;
//                  a DENIED attempt = the denylist did its job (suspicious, not a leak).
//   - rebuild.jsonl (the installer transcript): a tool call that fetched the target.
//
// Named residual limit (§7): this CANNOT catch weight-memorization (reproducing a
// popular published package from training memory, zero egress) — recorded, not caught.
//
// Usage: leakage-audit.mjs <egressLog> <transcript> <outPath>
//        --target-package <name> [--target-host <host>] [--target-repo <url>]
// Exit: 0 = pass; 8 = INVALIDATED (leak). (Also writes the verdict to <outPath>.)

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
function opt(f) { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; }
const [egressLog, transcript, outPath] = pos;
const targetPackage = opt('--target-package');
const targetHost = opt('--target-host');
const targetRepo = opt('--target-repo');
if (!egressLog || !transcript || !outPath) {
  console.error('usage: leakage-audit.mjs <egressLog> <transcript> <outPath> --target-package <name> [--target-host <host>] [--target-repo <url>]');
  process.exit(2);
}

const leaks = [];        // actual fetches of the target → INVALIDATE
const blockedAttempts = []; // denied attempts → denylist worked (report, don't invalidate)

// ---- egress.log evidence ---------------------------------------------------
if (existsSync(egressLog)) {
  for (const line of readFileSync(egressLog, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const isTargetPkg = e.package && targetPackage && e.package === targetPackage;
    const isTargetHost = e.host && targetHost && e.host === targetHost;
    if (isTargetPkg || isTargetHost) {
      const ev = { source: 'egress', ...e };
      if (e.action === 'ALLOW') leaks.push({ ...ev, why: 'target reached over the network (allowed egress)' });
      else blockedAttempts.push({ ...ev, why: 'target fetch attempted but denied by the denylist' });
    }
  }
}

// ---- transcript (rebuild.jsonl) evidence -----------------------------------
// Scan every tool call's text for a fetch of the target (npm install/view, git clone,
// a direct tarball URL). A transcript fetch is a LEAK unless egress proves it was denied.
const denied = new Set(blockedAttempts.map((b) => b.package || b.host));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scanText(t) {
  if (!t || typeof t !== 'string') return;
  const lc = t.toLowerCase();
  const pkgRe = targetPackage ? esc(targetPackage.toLowerCase()) : null;
  // (a) a package-manager install of the target
  const hitPkg = pkgRe && new RegExp(`\\b(npm\\s+(i|install|view|pack|cache\\s+add)|yarn\\s+add|pnpm\\s+add)\\b[^\\n]*\\b${pkgRe}\\b`).test(lc);
  // (b) a DIRECT tarball/registry fetch of the target (the bypass the proxy registry-tunnel
  //     deny closes live; caught here too in case a raw client reached a registry mirror):
  //     ".../<pkg>/-/<pkg>-x.tgz" or "registry.../<pkg>" via curl/wget/fetch/http.
  const hitTarball = pkgRe && (new RegExp(`/${pkgRe}/-/`).test(lc) || new RegExp(`registry[^\\s]*/${pkgRe}(?:[/"'?]|$)`).test(lc));
  const hitRepo = targetRepo && lc.includes(targetRepo.toLowerCase().replace(/\.git$/, ''));
  const hitHost = targetHost && new RegExp(`\\b(git\\s+clone|curl|wget|fetch)\\b[^\\n]*${esc(targetHost.toLowerCase())}`).test(lc);
  if (hitPkg || hitTarball || hitRepo || hitHost) {
    const blockedByDenylist = ((hitPkg || hitTarball) && denied.has(targetPackage)) || ((hitRepo || hitHost) && denied.has(targetHost));
    const kinds = [hitPkg && 'pkg-install', hitTarball && 'tarball', hitRepo && 'repo-path', hitHost && 'host-fetch'].filter(Boolean);
    const rec = { source: 'transcript', kinds, sample: t.slice(0, 160), blockedByDenylist };
    if (blockedByDenylist) blockedAttempts.push(rec); else leaks.push({ ...rec, why: 'transcript shows a target fetch not proven blocked' });
  }
}
// Scan ONLY the installer's OWN ACTIONS — the COMMAND inputs of tool_use blocks (Bash).
// A fetch is something the installer DID. We must NOT scan tool_result blocks (echoed file
// reads / command output) or assistant prose: the seed is a seed FOR the target, so it
// legitimately names the package and may document the original's `npm install <target>` —
// reading it is not fetching it. (Scanning whole events caused false-positive INVALIDATIONs.)
function commandStringsFrom(ev) {
  const out = [];
  const blocks = ev && ev.message && ev.message.content;
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use') continue;        // ONLY actions, never tool_result/text
    const inp = b.input || {};
    for (const k of ['command', 'cmd', 'script']) if (typeof inp[k] === 'string') out.push(inp[k]);
  }
  return out;
}
if (existsSync(transcript)) {
  for (const line of readFileSync(transcript, 'utf8').split('\n').filter(Boolean)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    for (const cmd of commandStringsFrom(ev)) scanText(cmd);
  }
}

const verdict = leaks.length ? 'INVALIDATED' : 'pass';
const report = {
  schemaVersion: 1,
  stage: 'leakage-audit',
  target: { package: targetPackage, host: targetHost, repo: targetRepo },
  verdict,
  leaks,
  blockedAttempts,
  residualLimit: 'Closed live: the target npm package (registry mode) + direct registry HTTPS tunnels (proxy denies CONNECT to the registry host → package fetches use the visible, denylist-checked path). Caught post-hoc here: a target package-manager install, a direct tarball/registry-path fetch, or a target repo-path clone in the transcript. Residual (recorded, not caught): (1) weight-memorization — an installer reproducing a popular published package from training memory with ZERO egress is invisible; (2) a raw-socket client that ignores *_PROXY and exfiltrates over the bridge gateway is unlogged at the host level (the transcript scan is the backstop). Unpublished targets (no public package/repo) are immune to both.',
};
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`[leakage-audit] verdict: ${verdict} (${leaks.length} leak(s), ${blockedAttempts.length} blocked attempt(s))`);
for (const l of leaks) console.log(`  LEAK: ${l.why} — ${l.package || l.host || l.sample || ''}`);
process.exit(verdict === 'INVALIDATED' ? 8 : 0);
