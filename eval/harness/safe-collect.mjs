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

import { readdirSync, lstatSync, mkdirSync, writeFileSync, realpathSync, existsSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

// Copy a file refusing to follow a symlink AT OPEN TIME (O_NOFOLLOW). Defeats a
// TOCTOU race where a cook bg process swaps a regular file -> symlink between the
// walk (lstat) and the copy: open() with O_NOFOLLOW fails with ELOOP on a symlink,
// and we re-assert it's a regular file via fstat on the open fd. (Primary defense is
// freezing the container before collection; this is by-construction belt+suspenders.)
function copyNoFollow(from, to) {
  let fd;
  try { fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) return { ok: false }; throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false };          // not a regular file (symlink/special) -> refuse
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0; while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    writeFileSync(to, buf.subarray(0, off));
    return { ok: true };
  } finally { closeSync(fd); }
}

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

// ---- copy regular files + dirs into dest (O_NOFOLLOW, TOCTOU-safe) ----------
mkdirSync(dest, { recursive: true });
for (const d of dirs) mkdirSync(join(dest, d), { recursive: true });
const raced = [];
for (const f of files) {
  const to = join(dest, f);
  mkdirSync(dirname(to), { recursive: true });
  if (!copyNoFollow(join(src, f), to).ok) raced.push(f);  // became a symlink/special since the walk
}
if (raced.length) {
  console.error(`[${label}] ABORT (TOCTOU): ${raced.length} file(s) became a symlink/special between walk and copy — refusing: ${raced.join(', ')}`);
  if (manifestPath) writeFileSync(manifestPath, JSON.stringify({ label, src, dest, ok: false, symlinks: raced, files: [] }, null, 2) + '\n');
  process.exit(8);
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
