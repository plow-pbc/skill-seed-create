#!/usr/bin/env node
// Full-tree target-absence scan for the vendored deps (Chunk-4 fix Imp2).
// Top-level absence is not enough: the target could hide as a NESTED dependency or
// under an npm ALIAS (different package name resolving to the same repo). Scan the
// ENTIRE node_modules tree for the target by package NAME and by repository URL /
// "owner/repo" slug.
//
// Usage: assert-target-absent.mjs <node_modules-dir> <target-name> <repo-url>
// Exit: 0 absent (clean); 9 target found (breach); 1 bad args.

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [nm, target, repoUrl] = process.argv.slice(2);
if (!nm || !target || !repoUrl) { console.error('usage: assert-target-absent.mjs <node_modules> <target> <repo-url>'); process.exit(1); }

// derive the "owner/repo" slug from the repo url (e.g. shinshin86/oh-my-logo)
const slug = (repoUrl.replace(/\.git$/, '').match(/[:/]([^/]+\/[^/]+)$/) || [, ''])[1].toLowerCase();

const breaches = [];
let pkgScanned = 0, dirsNamedTarget = 0, symlinksChecked = 0;

// check a package.json (at `pj`) for name/repo matching the target
function checkPkg(pj, via) {
  try {
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    if (p && typeof p.name === 'string' && p.name.toLowerCase() === target.toLowerCase())
      breaches.push({ kind: 'package-name' + via, path: pj, name: p.name });
    const repo = p && p.repository;
    const rurl = (typeof repo === 'string' ? repo : (repo && repo.url) || '').toLowerCase();
    if (slug && rurl.includes(slug)) breaches.push({ kind: 'repository-url/alias' + via, path: pj, name: p.name, url: rurl });
    return p;
  } catch { return null; }
}

// walk every directory; flag dirs literally named <target>; parse every package.json.
// SYMLINKS are RESOLVED (Chunk-4 fix #2 IMPORTANT 2): a node_modules/<target> symlink
// (or a symlinked dep dir whose real package is the target) must NOT slip the scan.
function walk(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      symlinksChecked++;
      // a symlink literally named <target> is a breach regardless of where it points
      if (e.name === target) { breaches.push({ kind: 'symlink-named-target', path: full }); }
      // resolve and inspect the link target's package.json (do NOT recurse — loop-safe)
      try {
        const rp = realpathSync(full);
        if (statSync(rp).isDirectory()) {
          if (existsSync(join(rp, 'package.json'))) checkPkg(join(rp, 'package.json'), ' (via symlink)');
          if (rp.split('/').pop() === target) breaches.push({ kind: 'symlink-resolves-to-target-dir', path: full, name: rp });
        }
      } catch { /* dangling symlink: cannot resolve, not the target */ }
      continue;
    }
    if (e.isDirectory()) {
      if (e.name === target) { dirsNamedTarget++; breaches.push({ kind: 'dir-named-target', path: full }); }
      walk(full);
    } else if (e.name === 'package.json') {
      pkgScanned++;
      checkPkg(full, '');
    }
  }
}
if (existsSync(nm)) walk(nm);

console.log(`[vendor-scan] full-tree scan: ${pkgScanned} package.json parsed; ${symlinksChecked} symlink(s) resolved; dirs named "${target}": ${dirsNamedTarget}; slug="${slug}"`);
if (breaches.length) {
  console.error(`[vendor-scan] VENDOR BREACH: target "${target}" found in the vendored tree (${breaches.length}):`);
  for (const b of breaches) console.error(`    [${b.kind}] ${b.path}${b.name ? ` (name=${b.name})` : ''}${b.url ? ` (url=${b.url})` : ''}`);
  process.exit(9);
}
console.log(`[vendor-scan] OK: target "${target}" ABSENT from the full vendored tree (name + repo-url/alias).`);
process.exit(0);
