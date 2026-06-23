#!/usr/bin/env node
// Manifest-driven oracle strip (Chunk 3). Removes from the capture workspace every
// file matched by the oracle globs (tests incl. co-located, runner config, fixtures,
// snapshots) PLUS oracle.lockfile. Leaves everything else (package.json, src, README)
// in place. Removing-empty-dirs afterward keeps the workspace tidy.
//
// Withholding is glob/file-based (never "rm the test dir"), the SAME inventory the
// scorer runs — see config.json#oracle.
//
// Usage: strip-oracle.mjs <target> <workspace>

import { readdirSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from './load-config.mjs';

const [target, workspace] = process.argv.slice(2);
if (!target || !workspace) {
  console.error('usage: strip-oracle.mjs <target> <workspace>');
  process.exit(1);
}
const cfg = loadConfig(target);

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

const globs = [
  ...(cfg.oracle.tests || []),
  ...(cfg.oracle.config || []),
  ...(cfg.oracle.fixtures || []),
  ...(cfg.oracle.snapshots || []),
];
const res = globs.flatMap(expandBraces).map(globToRegex);
const exact = [cfg.oracle.lockfile].filter(Boolean);

const files = walk(workspace);
const toStrip = files.filter((f) => exact.includes(f) || res.some((r) => r.test(f)));

if (toStrip.length === 0) {
  console.error('[strip] WARNING: oracle globs matched ZERO files — check the manifest vs the checkout.');
}
for (const f of toStrip) {
  rmSync(join(workspace, f), { force: true });
  console.log(`[strip] removed: ${f}`);
}

// ---- redact ORACLE METADATA from RETAINED prose docs (review cycle 2, IMPORTANT 3) ----
// Stripping test BODIES is not enough: retained docs (CLAUDE.md/README) enumerate the
// test files + counts + coverage goals, leaking the oracle inventory the harness claims
// to withhold. Redact those lines from kept .md/.txt so claim==reality. (assert-stripped
// then proves zero residual leak.)
const testBasenames = (cfg.oracle?.expected?.testFiles || []).map((t) => t.split('/').pop()).filter(Boolean);
const LEAK_PATTERNS = [
  /__tests__/i,
  /\b\w[\w.-]*\.(test|spec)\.[a-z]+\b/i,         // any *.test.* / *.spec.* filename
  /\b\d+\s*(?:unit\s+|integration\s+)?tests?\b/i, // "94 tests"
  /coverage/i,                                    // coverage goals / reports
  /\btest\s+(?:suite|file|files|directory|structure)\b/i,
  ...testBasenames.map((b) => new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
];
const REDACTION = '[oracle metadata redacted by eval harness — test inventory withheld]';
let redactedLines = 0, redactedFiles = 0;
const remaining = walk(workspace).filter((f) => /\.(md|markdown|txt|rst)$/i.test(f));
for (const f of remaining) {
  const full = join(workspace, f);
  const src = readFileSync(full, 'utf8');
  const lines = src.split('\n');
  let hit = 0;
  const out = lines.map((ln) => {
    if (LEAK_PATTERNS.some((re) => re.test(ln))) { hit++; return REDACTION; }
    return ln;
  });
  if (hit) {
    writeFileSync(full, out.join('\n'));
    redactedLines += hit; redactedFiles++;
    console.log(`[strip] redacted ${hit} oracle-metadata line(s) in: ${f}`);
  }
}
console.log(`[strip] redaction: ${redactedLines} line(s) across ${redactedFiles} doc(s).`);

// prune now-empty directories (e.g. __tests__/) bottom-up
function pruneEmptyDirs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') pruneEmptyDirs(join(dir, e.name));
  }
  if (dir !== workspace) {
    try { if (readdirSync(dir).length === 0) { rmSync(dir, { recursive: true, force: true }); console.log(`[strip] pruned empty dir: ${relative(workspace, dir)}`); } } catch {}
  }
}
pruneEmptyDirs(workspace);

console.log(`[strip] stripped ${toStrip.length} oracle file(s).`);
