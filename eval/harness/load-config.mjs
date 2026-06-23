#!/usr/bin/env node
// Loader for target configs (Chunk 1).
//
// A target config (targets/<name>/config.json) is the single source of truth for
// the eval loop: source pin, base image, build/test commands, devDeps, and the
// ORACLE MANIFEST (globs for tests/fixtures/snapshots/runner-config + lockfile).
// The same oracle inventory drives BOTH capture-withhold (Chunk 3) and
// scorer-run (Chunk 5).
//
// Runtime: pure Node, no third-party deps and no bleeding-edge APIs. Verified to
// run on the configured harness runtime (node:20.18.1) — see assertNodeVersion().
// Glob matching is implemented locally (brace-expand + glob->regex over a tree
// walk), so it does NOT depend on fs.globSync (Node 22+).
//
// Usage:
//   node harness/load-config.mjs <target>                 # load + validate, print summary
//   node harness/load-config.mjs <target> --json          # emit the validated config as JSON
//   node harness/load-config.mjs <target> --verify <dir>  # confirm <dir> is repoUrl@sha, then
//                                                          # expand oracle globs against it and
//                                                          # run a completeness scan
//
// Exit codes: 0 = ok; 1 = invalid config / missing fields; 2 = verification mismatch.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_DIR = resolve(__dirname, '..', 'targets');
const MIN_NODE_MAJOR = 18; // config baseImage is node:20.x; loader must run on >=18

export class ConfigError extends Error {}

// ---- validation ----------------------------------------------------------

// Must be present AND non-empty (strings/arrays).
const REQUIRED_NONEMPTY = [
  'schemaVersion',
  'name',
  'source.repoUrl',
  'source.sha',
  'baseImage',
  'commands.install',
  'commands.build',
  'commands.test',
  'devDeps',
  'oracle.tests',
  'oracle.config',
  'oracle.lockfile',
  'oracle.testCommand',
  'oracle.expected.testFiles',
];

// Must be PRESENT (defined) but may be empty — forces future manifests to make
// "no fixtures / no snapshots" an explicit, reviewed decision, not an omission.
const REQUIRED_PRESENT = ['oracle.fixtures', 'oracle.snapshots'];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function isEmpty(v) {
  if (v == null) return true;
  if (Array.isArray(v) || typeof v === 'string') return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// Throws ConfigError on any problem. Importable by later chunks.
export function loadConfig(target) {
  const file = join(TARGETS_DIR, target, 'config.json');
  if (!existsSync(file)) throw new ConfigError(`no config at ${file}`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${e.message}`);
  }
  const missing = REQUIRED_NONEMPTY.filter((p) => isEmpty(get(cfg, p)));
  if (missing.length) throw new ConfigError(`config missing/empty required field(s): ${missing.join(', ')}`);
  const absent = REQUIRED_PRESENT.filter((p) => get(cfg, p) === undefined);
  if (absent.length) throw new ConfigError(`config must declare (even if empty): ${absent.join(', ')}`);
  if (!/^[0-9a-f]{40}$/.test(cfg.source.sha)) {
    throw new ConfigError(`source.sha is not a full 40-char git SHA: ${cfg.source.sha}`);
  }
  cfg.__file = file;
  return cfg;
}

// ---- portable glob (no fs.globSync) --------------------------------------

// Expand {a,b,c} alternations (supports multiple groups; no nesting needed here).
function expandBraces(pattern) {
  const i = pattern.indexOf('{');
  if (i === -1) return [pattern];
  let depth = 0;
  let j = i;
  for (; j < pattern.length; j++) {
    if (pattern[j] === '{') depth++;
    else if (pattern[j] === '}' && --depth === 0) break;
  }
  const pre = pattern.slice(0, i);
  const post = pattern.slice(j + 1);
  const opts = pattern.slice(i + 1, j).split(',');
  const out = [];
  for (const opt of opts) for (const tail of expandBraces(post)) out.push(pre + opt + tail);
  return out;
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function compileGlobs(globs) {
  return globs.flatMap(expandBraces).map(globToRegex);
}

function walkFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

function matchFiles(globs, files) {
  const res = compileGlobs(globs);
  return files.filter((f) => res.some((r) => r.test(f)));
}

// Expand the oracle globs (tests + config + non-empty fixtures/snapshots) against
// an already-walked file list. Returns sorted, de-duped relative paths.
export function expandOracle(cfg, files) {
  const globs = [
    ...(cfg.oracle.tests || []),
    ...(cfg.oracle.config || []),
    ...(cfg.oracle.fixtures || []),
    ...(cfg.oracle.snapshots || []),
  ];
  return [...new Set(matchFiles(globs, files))].sort();
}

// ---- completeness: catch test-shaped files that aren't inventoried --------

function isTestShaped(relPath) {
  const b = basename(relPath);
  if (/\.(test|spec)\./.test(b)) return true;
  if (relPath.split('/').includes('__tests__')) return true;
  if (/(^|[._-])test([._-]|$).*\.sh$/i.test(b)) return true; // test*.sh, *-test.sh, etc.
  return false;
}

// ---- verify ---------------------------------------------------------------

class VerifyError extends Error {}

function assertRepoAtSha(cfg, dir) {
  if (!existsSync(join(dir, '.git'))) {
    throw new VerifyError(`--verify dir is not a git checkout (no .git): ${dir}`);
  }
  let head;
  try {
    head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new VerifyError(`could not read git HEAD of ${dir}: ${e.message}`);
  }
  if (head !== cfg.source.sha) {
    throw new VerifyError(
      `checkout is NOT the pinned commit.\n  HEAD:   ${head}\n  config: ${cfg.source.sha}\n` +
        `Verification only means anything against ${cfg.source.repoUrl} @ ${cfg.source.sha}.`
    );
  }
  // Best-effort remote confirmation (don't hard-fail on shallow/renamed remotes).
  let remotes = '';
  try {
    remotes = execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8' });
  } catch { /* ignore */ }
  const repoKey = cfg.source.repoUrl.replace(/\.git$/, '');
  if (remotes && !remotes.includes(repoKey)) {
    console.log(`  WARN: no remote matches ${cfg.source.repoUrl} (HEAD still matches sha; continuing)`);
  }
  return head;
}

function verify(cfg, checkoutDir) {
  const dir = resolve(checkoutDir);
  if (!existsSync(dir)) throw new VerifyError(`--verify dir does not exist: ${dir}`);

  // (1) ANCHOR: the tree must be repoUrl @ source.sha, else a fake dir could "pass".
  const head = assertRepoAtSha(cfg, dir);
  console.log(`Anchor OK: ${dir}`);
  console.log(`  git HEAD == source.sha (${head})\n`);

  const files = walkFiles(dir);

  // (2) MATCH: oracle globs must expand to exactly the expected inventory.
  const matched = expandOracle(cfg, files);
  const expected = [...cfg.oracle.expected.testFiles, ...(cfg.oracle.expected.configFiles || [])].sort();
  const missing = expected.filter((f) => !matched.includes(f));
  const extra = matched.filter((f) => !expected.includes(f));

  console.log('Oracle globs expanded against the checkout:');
  for (const f of matched) console.log(`  match: ${f}`);
  console.log(`Expected ${expected.length} file(s), matched ${matched.length}.`);
  if (missing.length) console.log(`  MISSING (expected, not matched): ${missing.join(', ')}`);
  if (extra.length) console.log(`  EXTRA (matched, not expected): ${extra.join(', ')}`);

  // (3) LOCKFILE: the determinism input must actually be present at the SHA.
  const lockPresent = files.includes(cfg.oracle.lockfile);
  console.log(`\nLockfile (${cfg.oracle.lockfile}): ${lockPresent ? 'present' : 'MISSING'}`);

  // (4) COMPLETENESS: nothing test-shaped may be present-but-not-inventoried.
  const inventoried = new Set([
    ...matched,
    cfg.oracle.lockfile,
    ...(cfg.oracle.excludedTestShaped || []).map((e) => e.path),
  ]);
  const testShaped = files.filter(isTestShaped);
  const uninventoried = testShaped.filter((f) => !inventoried.has(f));
  const excludedPaths = new Set((cfg.oracle.excludedTestShaped || []).map((e) => e.path));
  console.log('\nCompleteness scan (test-shaped files in tree):');
  for (const f of testShaped) {
    const tag = matched.includes(f)
      ? 'inventoried'
      : excludedPaths.has(f)
        ? 'excluded (documented)'
        : 'UNINVENTORIED';
    console.log(`  ${tag}: ${f}`);
  }

  const problems = [];
  if (missing.length || extra.length) problems.push('oracle globs do not match the expected inventory');
  if (!lockPresent) problems.push(`lockfile ${cfg.oracle.lockfile} absent at SHA`);
  if (uninventoried.length) problems.push(`test-shaped files not inventoried: ${uninventoried.join(', ')}`);
  if (problems.length) throw new VerifyError(problems.join('; '));

  console.log('\nOK: anchored to repo@sha, oracle globs confirmed, lockfile present, completeness clean.');
}

// ---- CLI ------------------------------------------------------------------

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`load-config: ERROR: requires Node >= ${MIN_NODE_MAJOR} (running ${process.versions.node})`);
    process.exit(1);
  }
}

function main() {
  assertNodeVersion();
  const [target, ...rest] = process.argv.slice(2);
  if (!target) {
    console.error('usage: load-config.mjs <target> [--json | --verify <dir>]');
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig(target);
  } catch (e) {
    console.error(`load-config: ${e.message}`);
    process.exit(1);
  }

  if (rest[0] === '--json') {
    const { __file, ...clean } = cfg;
    console.log(JSON.stringify(clean, null, 2));
    return;
  }
  if (rest[0] === '--verify') {
    if (!rest[1]) {
      console.error('usage: load-config.mjs <target> --verify <checkout-dir>');
      process.exit(1);
    }
    try {
      verify(cfg, rest[1]);
    } catch (e) {
      console.error(`\nload-config: VERIFY FAILED: ${e.message}`);
      process.exit(2);
    }
    return;
  }

  console.log(`target:     ${cfg.name}`);
  console.log(`source:     ${cfg.source.repoUrl} @ ${cfg.source.ref ?? cfg.source.sha}`);
  console.log(`sha:        ${cfg.source.sha}`);
  console.log(`baseImage:  ${cfg.baseImage}`);
  console.log(`install:    ${cfg.commands.install}`);
  console.log(`build:      ${cfg.commands.build}`);
  console.log(`test:       ${cfg.commands.test}`);
  console.log(`devDeps:    ${Object.keys(cfg.devDeps).length} packages`);
  console.log(`lockfile:   ${cfg.oracle.lockfile}`);
  console.log(`oracle:`);
  console.log(`  tests:    ${cfg.oracle.tests.join(', ')}`);
  console.log(`  config:   ${cfg.oracle.config.join(', ')}`);
  console.log(`  fixtures: ${cfg.oracle.fixtures.length ? cfg.oracle.fixtures.join(', ') : '(none)'}`);
  console.log(`  snapshots:${cfg.oracle.snapshots.length ? ' ' + cfg.oracle.snapshots.join(', ') : ' (none)'}`);
  console.log(`  excluded: ${(cfg.oracle.excludedTestShaped || []).map((e) => e.path).join(', ') || '(none)'}`);
  console.log(`  expected: ${cfg.oracle.expected.testFiles.length} test file(s)`);
  console.log(`\nLoaded OK. Run with --verify <checkout@sha> to confirm globs + completeness.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
