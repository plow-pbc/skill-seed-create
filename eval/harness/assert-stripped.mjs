#!/usr/bin/env node
// Assert the capture workspace has the oracle GLOB-STRIPPED (Chunk 3).
//
// Reuses Chunk 1's portable glob expansion: expands every oracle glob (tests,
// config, fixtures, snapshots) PLUS oracle.lockfile against the stripped
// workspace and asserts ZERO matches. Also asserts package.json (capability
// context) is STILL present. Writes a strip-manifest to <runDir>/strip-manifest.json.
//
// Exit: 0 = clean strip; 5 = an oracle artifact survived / package.json missing.
//
// Usage: assert-stripped.mjs <target> <workspace> <runDir>

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from './load-config.mjs';

const [target, workspace, runDir] = process.argv.slice(2);
if (!target || !workspace || !runDir) {
  console.error('usage: assert-stripped.mjs <target> <workspace> <runDir>');
  process.exit(1);
}

const cfg = loadConfig(target);

// --- portable glob (mirrors load-config.mjs; kept local to avoid exporting internals) ---
function expandBraces(p) {
  const i = p.indexOf('{');
  if (i === -1) return [p];
  let d = 0, j = i;
  for (; j < p.length; j++) { if (p[j] === '{') d++; else if (p[j] === '}' && --d === 0) break; }
  const pre = p.slice(0, i), post = p.slice(j + 1), opts = p.slice(i + 1, j).split(',');
  return opts.flatMap((o) => expandBraces(post).map((t) => pre + o + t));
}
function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; } else { re += '.*'; i += 1; } }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

const oracleGlobs = [
  ...(cfg.oracle.tests || []),
  ...(cfg.oracle.config || []),
  ...(cfg.oracle.fixtures || []),
  ...(cfg.oracle.snapshots || []),
];
const oracleExactFiles = [cfg.oracle.lockfile].filter(Boolean);

const files = walk(workspace);
const res = oracleGlobs.flatMap(expandBraces).map(globToRegex);
const survivedByGlob = files.filter((f) => res.some((r) => r.test(f)));
const survivedExact = oracleExactFiles.filter((f) => files.includes(f));
const survived = [...new Set([...survivedByGlob, ...survivedExact])].sort();

const packageJsonPresent = files.includes('package.json'); // capability context must remain

// ---- residual oracle-metadata leak scan (review cycle 2, IMPORTANT 3) -------
// SCOPE OF THE CLAIM (guardfix2): what is withheld = test BODIES (the test files
// themselves), test-file ENUMERATION, and test COUNTS/coverage goals — in PROSE docs
// (.md/.txt). What is RETAINED as capability context = package.json and biome.json
// (deps/bin/scripts/format config), even though they reference a test runner
// (`vitest`, `test:coverage`, `__tests__/**`): a runner existing is not the oracle.
// So this scan covers prose docs only; package.json/biome.json are deliberately kept.
const testBasenames = (cfg.oracle?.expected?.testFiles || []).map((t) => t.split('/').pop()).filter(Boolean);
const LEAK_PATTERNS = [
  { name: '__tests__ reference', re: /__tests__/i },
  { name: 'test/spec filename', re: /\b\w[\w.-]*\.(test|spec)\.[a-z]+\b/i },
  { name: 'explicit test count', re: /\b\d+\s*(?:unit\s+|integration\s+)?tests?\b/i },
  { name: 'coverage reference', re: /coverage/i },
  ...testBasenames.map((b) => ({ name: `oracle test name ${b}`, re: new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
];
const proseFiles = files.filter((f) => /\.(md|markdown|txt|rst)$/i.test(f));
const leaks = [];
for (const f of proseFiles) {
  const lines = readFileSync(join(workspace, f), 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const p of LEAK_PATTERNS) if (p.re.test(ln)) leaks.push({ file: f, line: i + 1, kind: p.name, text: ln.slice(0, 80) });
  });
}

const manifest = {
  schemaVersion: 1,
  target: cfg.name,
  sha: cfg.source.sha,
  workspace,
  strippedGlobs: oracleGlobs,
  strippedExactFiles: oracleExactFiles,
  oracleArtifactsSurviving: survived, // MUST be empty
  packageJsonPresent,
  oracleMetadataLeaks: leaks, // MUST be empty (no test names/counts in retained prose)
  remainingFileCount: files.length,
  remainingFiles: files.sort(),
};
writeFileSync(join(runDir, 'strip-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`[strip] workspace files: ${files.length}`);
console.log(`[strip] oracle artifacts surviving the strip: ${survived.length}`);
for (const f of survived) console.log(`  SURVIVED: ${f}`);
console.log(`[strip] package.json present (capability context): ${packageJsonPresent}`);
console.log(`[strip] oracle-metadata leaks in retained prose: ${leaks.length}`);
for (const l of leaks) console.log(`  LEAK ${l.file}:${l.line} (${l.kind}): ${l.text}`);

if (survived.length > 0) {
  console.error(`\n[strip] ABORT: ${survived.length} oracle artifact(s) survived the strip — blindness compromised.`);
  process.exit(5);
}
if (!packageJsonPresent) {
  console.error(`\n[strip] ABORT: package.json missing — capability context was over-stripped.`);
  process.exit(5);
}
if (leaks.length > 0) {
  console.error(`\n[strip] ABORT: ${leaks.length} oracle-metadata leak(s) (test names/counts/coverage) survived in retained docs — prior-knowledge blindness compromised.`);
  process.exit(5);
}
console.log(`\n[strip] OK: oracle test bodies/enumeration/counts withheld (incl. redacted prose); package.json + biome.json retained as capability context (a runner reference is not the oracle). strip-manifest.json written.`);
process.exit(0);
