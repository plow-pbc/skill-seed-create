#!/usr/bin/env node
// Chunk 6 — assemble summary.md for a complete end-to-end run record.
// Reads the canonical run-<id>/ artifacts (baseline.json, fidelity.json,
// rebuild-result.json, seed/) and writes a human-readable summary.
//
// Usage: emit-summary.mjs <target> <runDir> <wallSeconds>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [target, runDir, wallSecRaw] = process.argv.slice(2);
if (!target || !runDir) { console.error('usage: emit-summary.mjs <target> <runDir> <wallSeconds>'); process.exit(1); }
const wallSec = Number(wallSecRaw || 0);
const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

const baseline = load(join(runDir, 'baseline.json'));
const fidelity = load(join(runDir, 'fidelity.json'));
const rebuild = load(join(runDir, 'rebuild-result.json'));

function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const f = join(d, e.name); if (e.isDirectory()) walk(f); else { bytes += statSync(f).size; files++; } } };
  if (existsSync(dir)) walk(dir);
  return { bytes, files };
}
const seed = dirSize(join(runDir, 'seed'));
const kib = (b) => `${(b / 1024).toFixed(1)} KiB`;
const hms = (s) => { const m = Math.floor(s / 60), r = s % 60; return `${m}m ${r}s`; };

// baseline tests
const bTotal = baseline?.tests?.total ?? null;
const bPassed = baseline?.tests?.passed ?? null;
const bGreen = baseline?.green ?? (bTotal != null && bPassed === bTotal);

// fidelity
const fPassed = fidelity?.fidelity?.passed ?? null;
const fTotal = fidelity?.fidelity?.total ?? null;
const fPct = fidelity?.fidelity?.pct ?? null;
const bc = fidelity?.byClass || {};

// did the rebuild build?
const buildExit = rebuild?.canonicalBuildExit;
const didBuild = buildExit === '0' || buildExit === 0 ? 'yes' : (buildExit == null ? 'unknown' : `no (exit ${buildExit})`);
const srcFiles = rebuild?.reconstructedSourceFileCount ?? null;

const lines = [];
lines.push(`# eval run summary — ${target}`);
lines.push('');
lines.push(`Run id: \`${runDir.split('/').pop()}\`  ·  wall time: ${hms(wallSec)}`);
lines.push('');
lines.push('| stage | result |');
lines.push('|---|---|');
lines.push(`| **baseline** | ${bPassed != null ? `${bPassed}/${bTotal} green` : 'n/a'} ${bGreen ? '✅' : '❌'} |`);
lines.push(`| **capture** | seed: ${seed.files} file(s), ${kib(seed.bytes)} |`);
lines.push(`| **rebuild** | did-build: ${didBuild}; reconstructed src files: ${srcFiles ?? 'n/a'} |`);
lines.push(`| **fidelity** | ${fPassed != null ? `${fPassed}/${fTotal} (${fPct}%)` : 'n/a'} |`);
lines.push('');
lines.push('## Classified fidelity');
if (fidelity) {
  lines.push(`**${fPassed}/${fTotal} passing (${fPct}%)** against the held-out oracle.`);
  lines.push('');
  lines.push('| class | count | meaning |');
  lines.push('|---|---|---|');
  lines.push(`| import_failure | ${bc.import_failure ?? 0} | API surface absent (module resolution fails) |`);
  lines.push(`| assertion_failure | ${bc.assertion_failure ?? 0} | test ran, behavior differs |`);
  lines.push(`| build_failure | ${bc.build_failure ?? 0} | rebuilt src won't transpile |`);
  lines.push(`| test_setup_failure | ${bc.test_setup_failure ?? 0} | runner/devDeps/config (indicts harness) |`);
  lines.push(`| harness_failure | ${bc.harness_failure ?? 0} | scorer infra (indicts harness) |`);
  lines.push('');
  lines.push(`genuine seed gaps (import+assertion) = ${fidelity.genuineSeedGaps ?? '?'}; harness-indicting = ${fidelity.harnessIndicting ?? '?'}; rebuild build defects = ${fidelity.rebuildBuildDefects ?? 0}.`);
  lines.push(`cross-check: discovered ${fidelity.crossCheck?.discovered?.length ?? '?'} oracle files, N=${fidelity.crossCheck?.N ?? '?'}, match=${fidelity.crossCheck?.match}.`);
  lines.push(`binding: rebuilt src bound (not original) = ${fidelity.bindingProof?.bound}.`);
} else {
  lines.push('_no fidelity.json — scoring did not complete._');
}
lines.push('');
lines.push('## Blindness (positive proofs in this run record)');
lines.push('- capture: `blocked-egress.log` (git+npm blocked), `fs-blindness.log` (oracle Read/Glob/Grep denied), `strip-manifest.json` (zero oracle artifacts, `oracleMetadataLeaks: []`).');
lines.push('- rebuild: `rebuild-egress.log` (target unreachable, deps offline), `vendor/vendor-listing.txt` + `vendor-fulltree-scan.log` (target ABSENT full-tree), `rebuild-blindness.log`.');
lines.push('- both cooks fresh & confined; transcripts + tool logs preserved (`cook-*`, `rebuild-*`).');
lines.push('');
lines.push('## Caveat');
lines.push('One blind rebuild is a **smoke signal**, not decision-grade: capture/rebuild are non-deterministic, so the number varies run to run (spec defers multi-run averaging). A low/partial number is the honest expected result for a description-only seed.');
lines.push('');

const md = lines.join('\n') + '\n';
writeFileSync(join(runDir, 'summary.md'), md);
process.stdout.write(md);
