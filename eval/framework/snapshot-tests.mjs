#!/usr/bin/env node
// Snapshot the held-out copy of the project's tests (Setup stage, §4).
//
// Copies every file under <source> matching the manifest's setup.testGlobs (plus an
// optional lockfile) into <dest> (oracle/tests-locked), preserving relative paths.
// This is the SCORER-ONLY copy: source/ is what the Seed Creator touches, so the
// Evaluator must never run *that* tree — it runs this frozen snapshot instead.
//
// Pure Node (no deps); the glob engine mirrors the proven harness loader.
//
// Usage: snapshot-tests.mjs <sourceDir> <destDir> <globsJson> [lockfile]
//   <globsJson> = JSON array of globs relative to <sourceDir>
// Prints a JSON manifest { files:[...], lockfile, count } to stdout.
// Exit: 0 ok (>=1 file copied); 3 zero matches (a no-op snapshot is a Setup bug).

import { readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const [sourceDir, destDir, globsJson, lockfile] = process.argv.slice(2);
if (!sourceDir || !destDir || !globsJson) {
  console.error('usage: snapshot-tests.mjs <sourceDir> <destDir> <globsJson> [lockfile]');
  process.exit(2);
}

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
function copyInto(rel) {
  const dst = join(destDir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(sourceDir, rel), dst);
}

const globs = JSON.parse(globsJson);
const res = globs.flatMap(expandBraces).map(globToRegex);
const files = walk(sourceDir);
const matched = [...new Set(files.filter((f) => res.some((r) => r.test(f))))].sort();

mkdirSync(destDir, { recursive: true });
for (const f of matched) copyInto(f);

let lockCopied = null;
if (lockfile && existsSync(join(sourceDir, lockfile)) && statSync(join(sourceDir, lockfile)).isFile()) {
  copyInto(lockfile);
  lockCopied = lockfile;
}

const manifest = { files: matched, lockfile: lockCopied, count: matched.length };
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');

if (matched.length === 0) {
  console.error('snapshot-tests: ABORT — testGlobs matched ZERO files (held-out snapshot would be empty).');
  process.exit(3);
}
