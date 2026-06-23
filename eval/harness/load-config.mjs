#!/usr/bin/env node
// Loader for target configs (Chunk 1).
//
// A target config (targets/<name>/config.json) is the single source of truth for
// the eval loop: source pin, base image, build/test commands, devDeps, and the
// ORACLE MANIFEST (globs for tests/fixtures/snapshots/runner-config). The same
// oracle inventory drives BOTH capture-withhold (Chunk 3) and scorer-run (Chunk 5).
//
// Usage:
//   node harness/load-config.mjs <target>                 # load + validate, print summary
//   node harness/load-config.mjs <target> --json          # emit the validated config as JSON
//   node harness/load-config.mjs <target> --verify <dir>  # expand oracle globs against a real
//                                                          # checkout @ SHA and confirm they match
//                                                          # the manifest's expected file list
//
// Exit codes: 0 = ok; 1 = invalid config / missing fields; 2 = glob verification mismatch.

import { readFileSync, globSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_DIR = resolve(__dirname, '..', 'targets');

const REQUIRED = [
  'schemaVersion',
  'name',
  'source.repoUrl',
  'source.sha',
  'baseImage',
  'commands.build',
  'commands.test',
  'devDeps',
  'oracle.tests',
  'oracle.config',
  'oracle.expected.testFiles',
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fail(msg, code = 1) {
  console.error(`load-config: ERROR: ${msg}`);
  process.exit(code);
}

export function loadConfig(target) {
  const file = join(TARGETS_DIR, target, 'config.json');
  if (!existsSync(file)) fail(`no config at ${file}`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`config is not valid JSON: ${e.message}`);
  }
  const missing = REQUIRED.filter((p) => {
    const v = get(cfg, p);
    return v == null || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) fail(`config missing required field(s): ${missing.join(', ')}`);
  if (!/^[0-9a-f]{40}$/.test(cfg.source.sha)) {
    fail(`source.sha is not a full 40-char git SHA: ${cfg.source.sha}`);
  }
  cfg.__file = file;
  return cfg;
}

// Expand the oracle globs (tests + config + non-empty fixtures/snapshots) against a
// checkout directory and return the sorted, de-duped set of matched relative paths.
export function expandOracle(cfg, checkoutDir) {
  const globs = [
    ...(cfg.oracle.tests || []),
    ...(cfg.oracle.config || []),
    ...(cfg.oracle.fixtures || []),
    ...(cfg.oracle.snapshots || []),
  ];
  const set = new Set();
  for (const g of globs) {
    for (const m of globSync(g, { cwd: checkoutDir })) set.add(m);
  }
  return [...set].sort();
}

function verify(cfg, checkoutDir) {
  const dir = resolve(checkoutDir);
  if (!existsSync(dir)) fail(`--verify dir does not exist: ${dir}`, 2);
  const matched = expandOracle(cfg, dir);
  const expected = [
    ...cfg.oracle.expected.testFiles,
    ...(cfg.oracle.expected.configFiles || []),
  ].sort();
  const missing = expected.filter((f) => !matched.includes(f));
  const extra = matched.filter((f) => !expected.includes(f));

  console.log(`Oracle globs expanded against ${dir}:`);
  for (const f of matched) console.log(`  match: ${f}`);
  console.log(`\nExpected ${expected.length} file(s), matched ${matched.length}.`);
  if (missing.length) console.log(`  MISSING (expected, not matched): ${missing.join(', ')}`);
  if (extra.length) console.log(`  EXTRA (matched, not expected): ${extra.join(', ')}`);

  if (missing.length || extra.length) {
    fail('oracle globs do NOT match the expected file layout at this checkout', 2);
  }
  console.log('\nOK: oracle globs confirmed against the actual file layout.');
}

function main() {
  const [target, ...rest] = process.argv.slice(2);
  if (!target) fail('usage: load-config.mjs <target> [--json | --verify <dir>]');
  const cfg = loadConfig(target);

  if (rest[0] === '--json') {
    const { __file, ...clean } = cfg;
    console.log(JSON.stringify(clean, null, 2));
    return;
  }
  if (rest[0] === '--verify') {
    if (!rest[1]) fail('usage: load-config.mjs <target> --verify <checkout-dir>');
    verify(cfg, rest[1]);
    return;
  }

  // default: human summary
  console.log(`target:     ${cfg.name}`);
  console.log(`source:     ${cfg.source.repoUrl} @ ${cfg.source.ref ?? cfg.source.sha}`);
  console.log(`sha:        ${cfg.source.sha}`);
  console.log(`baseImage:  ${cfg.baseImage}`);
  console.log(`build:      ${cfg.commands.build}`);
  console.log(`test:       ${cfg.commands.test}`);
  console.log(`devDeps:    ${Object.keys(cfg.devDeps).length} packages`);
  console.log(`oracle:`);
  console.log(`  tests:    ${cfg.oracle.tests.join(', ')}`);
  console.log(`  config:   ${cfg.oracle.config.join(', ')}`);
  console.log(`  fixtures: ${cfg.oracle.fixtures.length ? cfg.oracle.fixtures.join(', ') : '(none)'}`);
  console.log(`  snapshots:${cfg.oracle.snapshots.length ? ' ' + cfg.oracle.snapshots.join(', ') : ' (none)'}`);
  console.log(`  expected: ${cfg.oracle.expected.testFiles.length} test file(s)`);
  console.log(`\nLoaded OK. Run with --verify <checkout> to confirm globs against a real layout.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
