#!/usr/bin/env node
// POSITIVE blindness + vendor proof for the clean-room rebuild (Chunk 4). Reuses
// the Chunk-3 machinery: it drives the SAME cook tool-guard (cook-tool-guard.mjs)
// with crafted events, here scoped to container R's rebuild workspace.
//
// Three things proven, all positively:
//   (1) FILESYSTEM blindness — the rebuild cook's file tools are confined to the
//       rebuild workspace (seed + vendored node_modules); the oracle (tests,
//       manifest) and any out-of-workspace path are DENIED. The rebuild cook is
//       oracle-naive: no teaching-to-the-test.
//   (2) NETWORK blindness — Bash is confined to docker exec into net-off R; host
//       shell / target fetch / web tools are DENIED.
//   (3) VENDOR + SEED state — node_modules is present, the TARGET package is ABSENT
//       from it (allowlist-by-construction), and the seed R received is description
//       -only (no *.ts/*.tsx/*.js source outside node_modules).
//
// Usage: assert-rebuild-blindness.mjs <target> <rebuild-workspace> <container> <runDir>
// Writes <runDir>/rebuild-blindness-proof.json + <runDir>/rebuild-blindness.log
// Exit: 0 all proven; 6 a confinement/vendor case FAILED.

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './load-config.mjs';

const [target, wsArg, container, runDir] = process.argv.slice(2);
if (!target || !wsArg || !container || !runDir) {
  console.error('usage: assert-rebuild-blindness.mjs <target> <rebuild-workspace> <container> <runDir>');
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'cook-tool-guard.mjs');
const WS = resolve(wsArg);
const cfg = loadConfig(target);
const EVAL_DIR = resolve(HERE, '..');
const MANIFEST = join(EVAL_DIR, 'targets', target, 'config.json');
const ALLOW_READ = process.env.COOK_ALLOW_READ || '';

function ask(evt) {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify(evt),
    env: { ...process.env, COOK_WORKSPACE: WS, COOK_CAPTURE_CONTAINER: container, COOK_ALLOW_READ: ALLOW_READ },
    encoding: 'utf8',
  });
  return JSON.parse(out).hookSpecificOutput || {};
}

const results = { filesystem: [], network: [], vendorState: [], seedState: [] };
let failed = 0;
function check(bucket, label, evt, expect) {
  const d = ask(evt);
  const ok = d.permissionDecision === expect;
  if (!ok) failed++;
  results[bucket].push({ label, expect, got: d.permissionDecision, ok, reason: d.permissionDecisionReason || '' });
}
function state(bucket, label, cond) {
  const ok = !!cond; if (!ok) failed++;
  results[bucket].push({ label, ok });
}

const cwd = WS;
const oracleRel = cfg.oracle?.expected?.testFiles?.[0] || '__tests__/lib.test.ts';

let symEscape = null;
try { symEscape = join(WS, '.rebuild-escape-probe'); rmSync(symEscape, { force: true }); symlinkSync('/', symEscape); } catch { symEscape = null; }

// ---- FILESYSTEM: oracle / out-of-workspace DENIED; in-workspace ALLOWED ----
check('filesystem', 'Read the oracle MANIFEST (config.json) is denied (oracle-naive)',
  { tool_name: 'Read', cwd, tool_input: { file_path: MANIFEST } }, 'deny');
check('filesystem', 'Read an oracle test file outside the workspace is denied',
  { tool_name: 'Read', cwd, tool_input: { file_path: '/var/tmp/oracle/' + oracleRel } }, 'deny');
check('filesystem', 'Read via ".." escaping the rebuild workspace is denied',
  { tool_name: 'Read', cwd, tool_input: { file_path: '../../../../etc/hostname' } }, 'deny');
if (symEscape) check('filesystem', 'Read through an in-workspace symlink escape (->/) is denied',
  { tool_name: 'Read', cwd, tool_input: { file_path: symEscape + '/etc/hostname' } }, 'deny');
check('filesystem', 'Grep the parent (runs) directory is denied',
  { tool_name: 'Grep', cwd, tool_input: { path: dirname(WS), pattern: 'describe\\(' } }, 'deny');
check('filesystem', 'Read the seed (SEED.md) inside the workspace is allowed',
  { tool_name: 'Read', cwd, tool_input: { file_path: 'SEED.md' } }, 'allow');
check('filesystem', 'Glob the rebuild workspace is allowed',
  { tool_name: 'Glob', cwd, tool_input: { path: WS, pattern: '**/*.md' } }, 'allow');
check('filesystem', 'Read a vendored dep manifest inside the workspace is allowed',
  { tool_name: 'Read', cwd, tool_input: { file_path: 'node_modules/typescript/package.json' } }, 'allow');

// ---- NETWORK: only docker-exec-into-net-off-R allowed ----
check('network', 'Bash plain host command denied',
  { tool_name: 'Bash', cwd, tool_input: { command: 'ls /' } }, 'deny');
check('network', 'Bash git clone the target denied',
  { tool_name: 'Bash', cwd, tool_input: { command: `git clone ${cfg.source.repoUrl} /tmp/x` } }, 'deny');
check('network', 'Bash npm install the target denied',
  { tool_name: 'Bash', cwd, tool_input: { command: 'npm install oh-my-logo' } }, 'deny');
check('network', 'WebFetch the target denied',
  { tool_name: 'WebFetch', cwd, tool_input: { url: cfg.source.repoUrl } }, 'deny');
check('network', 'Bash docker exec into the net-off rebuild container allowed',
  { tool_name: 'Bash', cwd, tool_input: { command: `docker exec ${container} sh -lc 'npx tsc -v'` } }, 'allow');

if (symEscape) { try { rmSync(symEscape, { force: true }); } catch {} }

// ---- VENDOR STATE: node_modules present, TARGET absent, deps present ----
const nm = join(WS, 'node_modules');
state('vendorState', 'vendored node_modules present in the rebuild workspace', existsSync(nm));
state('vendorState', `TARGET package "${target}" ABSENT from node_modules (allowlist-by-construction)`, !existsSync(join(nm, target)));
for (const d of ['typescript', 'vitest', 'tsx']) {
  state('vendorState', `expected dep present: ${d}`, existsSync(join(nm, d)));
}

// ---- SEED STATE: description-only (no impl source outside node_modules) ----
function walkNoNM(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkNoNM(full, base, out); else out.push(full.slice(base.length + 1));
  }
  return out;
}
const seedFiles = existsSync(WS) ? walkNoNM(WS) : [];
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const seedSource = seedFiles.filter((f) => SRC_EXT.has(extname(f).toLowerCase()));
state('seedState', 'SEED.md present in the seed R received', seedFiles.includes('SEED.md'));
state('seedState', 'NO bundled implementation source in the seed (description-only)', seedSource.length === 0);
results.seedState.push({ label: `seed files R received: ${seedFiles.join(', ') || '(none)'}`, ok: true, info: true });

// ---- emit ----
const counts = {}; let total = 0, passed = 0;
for (const k of Object.keys(results)) {
  const real = results[k].filter((r) => !r.info);
  counts[k] = { total: real.length, passed: real.filter((r) => r.ok).length };
  total += real.length; passed += counts[k].passed;
}
writeFileSync(join(runDir, 'rebuild-blindness-proof.json'),
  JSON.stringify({ schemaVersion: 1, target: cfg.name, rebuildWorkspace: WS, container, guard: GUARD, perAxis: counts, summary: { total, passed, failed: total - passed }, results }, null, 2) + '\n');

const lines = ['===== clean-room rebuild (container R) blindness + vendor proof ====='];
lines.push(`target=${cfg.name}  rebuild-workspace=${WS}  container=${container}`);
lines.push(`oracle manifest (must be unreadable): ${MANIFEST}`, '');
for (const axis of ['filesystem', 'network', 'vendorState', 'seedState']) {
  lines.push(`--- ${axis} ---`);
  for (const r of results[axis]) {
    if (r.info) { lines.push(`  [info] ${r.label}`); continue; }
    lines.push(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.expect ? `expect=${r.expect} got=${r.got}  ` : ''}${r.label}`);
    if (!r.ok && r.reason) lines.push(`         reason: ${r.reason}`);
  }
  lines.push('');
}
lines.push(`SUMMARY: ${passed}/${total} cases passed.`);
lines.push(failed === 0
  ? 'RESULT: REBUILD BLINDNESS PROVEN — oracle denied, net-off, target absent from vendor, seed description-only.'
  : `RESULT: COMPROMISED — ${failed} case(s) failed.`);
const log = lines.join('\n') + '\n';
writeFileSync(join(runDir, 'rebuild-blindness.log'), log);
process.stdout.write(log);
process.exit(failed > 0 ? 6 : 0);
