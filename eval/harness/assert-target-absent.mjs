#!/usr/bin/env node
// Full-tree target-absence scan for the vendored deps (Chunk-4 fix Imp2).
// Top-level absence is not enough: the target could hide as a NESTED dependency or
// under an npm ALIAS (different package name resolving to the same repo). Scan the
// ENTIRE node_modules tree for the target by package NAME and by repository URL /
// "owner/repo" slug.
//
// Usage: assert-target-absent.mjs <node_modules-dir> <target-name> <repo-url>
// Exit: 0 absent (clean); 9 target found (breach); 1 bad args.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [nm, target, repoUrl] = process.argv.slice(2);
if (!nm || !target || !repoUrl) { console.error('usage: assert-target-absent.mjs <node_modules> <target> <repo-url>'); process.exit(1); }

// derive the "owner/repo" slug from the repo url (e.g. shinshin86/oh-my-logo)
const slug = (repoUrl.replace(/\.git$/, '').match(/[:/]([^/]+\/[^/]+)$/) || [, ''])[1].toLowerCase();

const breaches = [];
let pkgScanned = 0, dirsNamedTarget = 0;

// walk every directory; flag dirs literally named <target>; parse every package.json
function walk(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;            // don't follow links during the scan
    if (e.isDirectory()) {
      if (e.name === target) { dirsNamedTarget++; breaches.push({ kind: 'dir-named-target', path: full }); }
      walk(full);
    } else if (e.name === 'package.json') {
      pkgScanned++;
      try {
        const p = JSON.parse(readFileSync(full, 'utf8'));
        if (p && typeof p.name === 'string' && p.name.toLowerCase() === target.toLowerCase())
          breaches.push({ kind: 'package-name', path: full, name: p.name });
        const repo = p && p.repository;
        const rurl = (typeof repo === 'string' ? repo : (repo && repo.url) || '').toLowerCase();
        if (slug && rurl.includes(slug))
          breaches.push({ kind: 'repository-url/alias', path: full, name: p.name, url: rurl });
      } catch { /* ignore unparseable package.json */ }
    }
  }
}
if (existsSync(nm)) walk(nm);

console.log(`[vendor-scan] full-tree scan: ${pkgScanned} package.json parsed; dirs named "${target}": ${dirsNamedTarget}; slug="${slug}"`);
if (breaches.length) {
  console.error(`[vendor-scan] VENDOR BREACH: target "${target}" found in the vendored tree (${breaches.length}):`);
  for (const b of breaches) console.error(`    [${b.kind}] ${b.path}${b.name ? ` (name=${b.name})` : ''}${b.url ? ` (url=${b.url})` : ''}`);
  process.exit(9);
}
console.log(`[vendor-scan] OK: target "${target}" ABSENT from the full vendored tree (name + repo-url/alias).`);
process.exit(0);
