#!/usr/bin/env node
// SHARED safe-collect: the ONE host-side collector for cook-produced files
// (Chunk 4 fix). The "symlink at a host<->container copy seam" bug appeared twice
// (seed path, then rebuilt-artifact path); this helper covers the seam CLASS by
// construction. Use it at EVERY host-side collection of cook output.
//
// Guarantees:
//   1) REFUSE symlinks — abort if ANY symlink exists anywhere under <src> (so the
//      host can never deref a cook symlink that points at the oracle/target).
//   2) copy NO-DEREF — only regular files + dirs are copied (symlinks would have
//      aborted; nothing is followed).
//   3) assert IN-TREE — every copied entry's realpath stays inside <dest>.
//   4) audit manifest INCLUDES symlinks — the file list records symlinks too, so an
//      audit can never hide one (here it's always [] because we abort on any).
//
// Usage: safe-collect.mjs <srcDir> <destDir> [--exclude a,b] [--manifest <path>] [--label <name>]
// Exit: 0 collected; 8 symlink/out-of-tree refusal; 1 bad args.

import { readdirSync, lstatSync, mkdirSync, copyFileSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [src, dest] = pos;
if (!src || !dest) { console.error('usage: safe-collect.mjs <srcDir> <destDir> [--exclude a,b] [--manifest p] [--label n]'); process.exit(1); }
const exclude = new Set((opt('--exclude') || '').split(',').filter(Boolean));
const manifestPath = opt('--manifest');
const label = opt('--label') || 'collect';

if (!existsSync(src)) { console.error(`[${label}] ABORT: src not found: ${src}`); process.exit(1); }

// ---- 1+2: walk src, abort on ANY symlink, gather regular files (no-deref) ----
const symlinks = [];
const files = [];   // relative paths of regular files
const dirs = [];    // relative paths of dirs (to recreate, incl. empty)
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (exclude.has(e.name)) continue;
    const full = join(dir, e.name);
    const rel = relative(src, full);
    // lstat: do NOT follow — detect symlinks explicitly
    const st = lstatSync(full);
    if (st.isSymbolicLink()) { symlinks.push(rel); continue; }
    if (st.isDirectory()) { dirs.push(rel); walk(full); }
    else if (st.isFile()) files.push(rel);
    else symlinks.push(rel + ' (special: not a regular file/dir)'); // sockets/fifos/devices: refuse too
  }
}
walk(src);

if (symlinks.length) {
  console.error(`[${label}] ABORT (symlink/special refusal): cook output contains ${symlinks.length} symlink/special entr(y/ies) — refusing to collect (could resolve to the oracle/target):`);
  for (const s of symlinks) console.error(`    ${s}`);
  // emit a manifest that RECORDS the symlinks so the audit can't hide them
  if (manifestPath) writeFileSync(manifestPath, JSON.stringify({ label, src, dest, ok: false, symlinks, files: [] }, null, 2) + '\n');
  process.exit(8);
}

// ---- copy regular files + dirs into dest (no-deref) ------------------------
mkdirSync(dest, { recursive: true });
for (const d of dirs) mkdirSync(join(dest, d), { recursive: true });
for (const f of files) {
  const to = join(dest, f);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(src, f), to);  // copies file contents; never follows a link (none exist)
}

// ---- 3: assert every dest entry resolves INSIDE dest ----------------------
const destReal = realpathSync(dest);
const escaped = [];
for (const f of files) {
  let rp; try { rp = realpathSync(join(dest, f)); } catch { rp = join(dest, f); }
  if (rp !== join(destReal, f) && !rp.startsWith(destReal + sep)) escaped.push(f);
}
if (escaped.length) {
  console.error(`[${label}] ABORT (out-of-tree): collected entries resolve outside ${dest}: ${escaped.join(', ')}`);
  process.exit(8);
}

// ---- 4: audit manifest (includes a symlinks field — always [] here) -------
const manifest = { label, src, dest, ok: true, symlinks, fileCount: files.length, files: files.sort() };
if (manifestPath) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[${label}] safe-collect OK: ${files.length} regular file(s) copied (0 symlinks; all in-tree).`);
process.exit(0);
