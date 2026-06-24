#!/usr/bin/env node
// Source-strip a seed copy before the blind rebuild (Chunk 4, head-chef Option 1).
//
// seed-create MAY non-deterministically bundle the implementation source (an app/
// or src/ tree, *.ts/*.tsx/*.js) into the seed. For fidelity to measure whether the
// DESCRIPTION alone reconstructs the capability, container R must receive ONLY the
// human-readable seed: SEED.md + README.md + scripts/ (+ docs/markdown/licence).
// Everything that looks like implementation source is removed here.
//
// Robust to the non-determinism: if a run bundled nothing, this is a no-op; if it
// did, stripping is what makes the rebuild number meaningful. Operates on a COPY
// (caller copies the seed first); never touches the original seed.
//
// Usage: strip-seed-source.mjs <seed-copy-dir> <runDir>
// Writes <runDir>/seed-as-received.json (the exact tree R gets + what was stripped).
// Exit: 0 ok; 1 bad args; 7 nothing recognisable as a seed remains (SEED.md gone).

import { readdirSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const [seedDir, runDir] = process.argv.slice(2);
if (!seedDir || !runDir) {
  console.error('usage: strip-seed-source.mjs <seed-copy-dir> <runDir>');
  process.exit(1);
}

// ALLOWLIST (Chunk-4 fix Imp1): "description-only" is ENFORCED, not assumed. R receives
// ONLY the natural-language seed + recognized helper shell scripts + plain docs/licence.
// EVERYTHING else — implementation source, binaries, archives, unknown payloads — is
// REJECTED (stripped) and logged, so a seed cannot smuggle source past the strip.
const ALLOW_NAMES = new Set(['SEED.md', 'README.md', 'LICENSE', 'LICENCE', '.gitignore']);
const ALLOW_DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst']);   // prose docs anywhere
const ALLOW_SCRIPT_EXT = new Set(['.sh']);                              // helper scripts under scripts/
// Smuggle signals — reject LOUDLY (not silently) if present:
const ARCHIVE_EXT = new Set(['.tar', '.tgz', '.gz', '.zip', '.bz2', '.xz', '.7z', '.rar', '.tar.gz']);
function isAllowed(rel) {
  const name = basename(rel);
  const ext = extname(rel).toLowerCase();
  if (ALLOW_NAMES.has(name)) return true;
  if (ALLOW_DOC_EXT.has(ext)) return true;
  if (rel.split('/')[0] === 'scripts' && ALLOW_SCRIPT_EXT.has(ext)) return true; // scripts/**/*.sh only
  return false;
}

// SYMLINK GUARD (guardfix2 CRITICAL): a seed must contain only regular files/dirs.
// A symlink could point at the oracle on a host that has it (the rebuild copy/cp would
// deref or carry it). Refuse the whole seed if ANY symlink is present.
function assertNoSymlinks(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      console.error(`[seed-strip] ABORT: symlink in seed — blindness breach: ${full}`);
      process.exit(7);
    }
    if (e.isDirectory()) assertNoSymlinks(full);
  }
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

assertNoSymlinks(seedDir);          // refuse a symlinked seed before doing anything
const before = walk(seedDir).sort();
const kept = [];
const stripped = [];                 // {file, reason}
const smuggleFlags = [];             // loud signals: archives / bundled-source-writing scripts

// looks-like-bundled-source heuristic for the smuggle log (does not gate; informative)
function looksBinary(abs) {
  try {
    const buf = readFileSync(abs);
    const n = Math.min(buf.length, 4096);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL byte => binary
    return false;
  } catch { return false; }
}
function scriptWritesSource(abs) {
  try {
    const t = readFileSync(abs, 'utf8');
    // heredoc / redirect that writes a source file => effectively bundling source
    return /<<\s*['"]?\w+['"]?[\s\S]*?\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)\b/.test(t)
        || />\s*\S+\.(ts|tsx|js|jsx|mjs|cjs)\b/.test(t)
        || /base64\s+-d|atob\(/.test(t);
  } catch { return false; }
}

for (const rel of before) {
  const abs = join(seedDir, rel);
  const ext = extname(rel).toLowerCase();
  if (isAllowed(rel)) {
    // a kept helper script that writes source files is a smuggle vector — flag (keep but loud)
    if (ext === '.sh' && scriptWritesSource(abs)) smuggleFlags.push({ file: rel, reason: 'script appears to write implementation source (heredoc/redirect/base64)' });
    kept.push(rel);
    continue;
  }
  // NOT allowlisted => reject (strip). Classify the reason; flag smuggle signals loudly.
  let reason = 'not in description-only allowlist';
  if (ARCHIVE_EXT.has(ext) || /\.tar\.gz$/i.test(rel)) { reason = 'ARCHIVE payload (possible bundled source)'; smuggleFlags.push({ file: rel, reason }); }
  else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|c|h|cpp|cc|css|scss|vue|svelte|json|json5)$/i.test(rel)) reason = 'implementation source';
  else if (looksBinary(abs)) { reason = 'BINARY payload (possible bundled artifact)'; smuggleFlags.push({ file: rel, reason }); }
  rmSync(abs, { force: true });
  stripped.push({ file: rel, reason });
}

// prune now-empty dirs (e.g. an emptied src/)
function pruneEmpty(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== '.git') pruneEmpty(join(dir, e.name));
  }
  if (dir !== seedDir) {
    try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
pruneEmpty(seedDir);

const after = walk(seedDir).sort();
const seedMdPresent = after.includes('SEED.md');
// allowlist invariant: NOTHING outside the allowlist may remain (enforced, not assumed)
const nonAllowedRemaining = after.filter((f) => !isAllowed(f));

const record = {
  schemaVersion: 1,
  seedDir,
  policy: 'allowlist: SEED.md + README.md + LICENSE + *.md/.txt docs + scripts/**/*.sh ONLY',
  filesBefore: before,
  filesStripped: stripped,        // {file, reason} — everything rejected by the allowlist
  smuggleFlags,                   // loud signals: archives, binaries, source-writing scripts
  filesReceivedByR: after,        // EXACTLY what container R gets (description-only)
  seedMdPresent,
  readmePresent: after.includes('README.md'),
  nonAllowedRemaining,            // MUST be empty
};
writeFileSync(join(runDir, 'seed-as-received.json'), JSON.stringify(record, null, 2) + '\n');

console.log(`[seed-strip] before: ${before.length} file(s); stripped ${stripped.length} (allowlist-rejected).`);
for (const s of stripped) console.log(`  STRIPPED [${s.reason}]: ${s.file}`);
for (const s of smuggleFlags) console.log(`  !! SMUGGLE FLAG [${s.reason}]: ${s.file}`);
console.log(`[seed-strip] R receives ${after.length} file(s): ${after.join(', ') || '(none)'}`);
console.log(`[seed-strip] SEED.md present: ${seedMdPresent} | README.md present: ${record.readmePresent}`);

if (nonAllowedRemaining.length) {
  console.error(`[seed-strip] ABORT: non-allowlisted file(s) survived: ${nonAllowedRemaining.join(', ')}`);
  process.exit(7);
}
if (!seedMdPresent || !record.readmePresent) {
  console.error('[seed-strip] ABORT: a SEED repo requires BOTH SEED.md and README.md.');
  process.exit(7);
}
console.log('[seed-strip] OK: R receives description-only seed (allowlist enforced; no symlinks).');
process.exit(0);
