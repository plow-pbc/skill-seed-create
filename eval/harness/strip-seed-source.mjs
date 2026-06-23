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

import { readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const [seedDir, runDir] = process.argv.slice(2);
if (!seedDir || !runDir) {
  console.error('usage: strip-seed-source.mjs <seed-copy-dir> <runDir>');
  process.exit(1);
}

// KEEP: the natural-language seed + helper shell scripts + docs. Everything else
// that is implementation source is stripped.
const KEEP_EXT = new Set(['.md', '.sh', '.txt']);
const KEEP_NAMES = new Set(['LICENSE', 'LICENCE', '.gitignore']);
// Implementation-source extensions that must NOT reach R (the whole point).
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.json5',
  '.py', '.go', '.rs', '.rb', '.java', '.c', '.h', '.cpp', '.cc', '.css', '.scss', '.vue', '.svelte',
]);

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

const before = walk(seedDir).sort();
const kept = [];
const stripped = [];

for (const rel of before) {
  const ext = extname(rel).toLowerCase();
  const name = basename(rel);
  const isScript = rel.split('/')[0] === 'scripts';      // scripts/ is allowed wholesale
  const keep = isScript || KEEP_EXT.has(ext) || KEEP_NAMES.has(name);
  // A source-extension file is stripped even inside scripts/ ONLY if it's clearly source;
  // but scripts/*.sh stays (it's a helper). Treat anything with a SOURCE_EXT as source
  // unless it's a kept doc extension.
  const isSource = SOURCE_EXT.has(ext) && !KEEP_EXT.has(ext);
  if (keep && !isSource) { kept.push(rel); continue; }
  if (isSource) { rmSync(join(seedDir, rel), { force: true }); stripped.push(rel); continue; }
  // unknown binary/asset (e.g. an image) — not source, not a doc: keep it (harmless).
  kept.push(rel);
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

const record = {
  schemaVersion: 1,
  seedDir,
  filesBefore: before,
  filesStripped: stripped,        // bundled implementation source removed
  filesReceivedByR: after,        // EXACTLY what container R gets
  seedMdPresent,
  sourceFilesRemaining: after.filter((f) => SOURCE_EXT.has(extname(f).toLowerCase()) && !KEEP_EXT.has(extname(f).toLowerCase())),
};
writeFileSync(join(runDir, 'seed-as-received.json'), JSON.stringify(record, null, 2) + '\n');

console.log(`[seed-strip] before: ${before.length} file(s); stripped ${stripped.length} source file(s).`);
for (const f of stripped) console.log(`  STRIPPED (source): ${f}`);
console.log(`[seed-strip] R receives ${after.length} file(s): ${after.join(', ') || '(none)'}`);
console.log(`[seed-strip] SEED.md present: ${seedMdPresent}`);

if (record.sourceFilesRemaining.length) {
  console.error(`[seed-strip] ABORT: source files survived: ${record.sourceFilesRemaining.join(', ')}`);
  process.exit(7);
}
if (!seedMdPresent) {
  console.error('[seed-strip] ABORT: no SEED.md remains — not a usable seed.');
  process.exit(7);
}
console.log('[seed-strip] OK: R receives description-only seed (SEED.md + README + scripts/docs).');
process.exit(0);
