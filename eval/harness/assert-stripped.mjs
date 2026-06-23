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

const manifest = {
  schemaVersion: 1,
  target: cfg.name,
  sha: cfg.source.sha,
  workspace,
  strippedGlobs: oracleGlobs,
  strippedExactFiles: oracleExactFiles,
  oracleArtifactsSurviving: survived, // MUST be empty
  packageJsonPresent,
  remainingFileCount: files.length,
  remainingFiles: files.sort(),
};
writeFileSync(join(runDir, 'strip-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`[strip] workspace files: ${files.length}`);
console.log(`[strip] oracle artifacts surviving the strip: ${survived.length}`);
for (const f of survived) console.log(`  SURVIVED: ${f}`);
console.log(`[strip] package.json present (capability context): ${packageJsonPresent}`);

if (survived.length > 0) {
  console.error(`\n[strip] ABORT: ${survived.length} oracle artifact(s) survived the strip — blindness compromised.`);
  process.exit(5);
}
if (!packageJsonPresent) {
  console.error(`\n[strip] ABORT: package.json missing — capability context was over-stripped.`);
  process.exit(5);
}
console.log(`\n[strip] OK: no oracle artifacts present; package.json retained. strip-manifest.json written.`);
process.exit(0);
