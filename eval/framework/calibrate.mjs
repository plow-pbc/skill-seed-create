#!/usr/bin/env node
// Calibration readout (Chunk 3, §9) — does our-criteria TRACK the unit-test score?
//
// oh-my-logo runs BOTH our behavioral criteria AND its 127 unit tests, so it lets us
// calibrate the criteria/rubric DISCIPLINE on a deterministic-text target: across a
// spectrum of installs of varying fidelity, do our coarse criteria move with the
// fine-grained unit suite? Reads the scorecards produced by evaluate.sh for each
// calibration install and emits the readout WITH the acceptance bar stated.
//
// NOTE on "multi-run": these calibration installs are deterministic CODE variants, so
// one score each is exact (the §4 N=5 averaging exists for NON-deterministic LLM installs).
// The "multi-run comparison" here is across the fidelity SPECTRUM, which is what §9 needs.
//
// Usage: calibrate.mjs <runsDir> <outPath> <baselineLabel> <label2> [<label3> ...]
//   baselineLabel = the known-good original. Exit 0 always (a readout, not a gate).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [runsDir, outPath, ...labels] = process.argv.slice(2);
if (!runsDir || !outPath || labels.length < 2) {
  console.error('usage: calibrate.mjs <runsDir> <outPath> <baselineLabel> <label2> [...]');
  process.exit(2);
}
const baseline = labels[0];

// THE ACCEPTANCE BAR (stated, Chunk-3 deliverable). our-criteria "tracks" the unit-test
// score iff ALL of these hold across the calibration spectrum:
const BAR = {
  yardstick: 'on the known-good original, our-criteria = 100% AND unit-tests = 100% (valid yardstick)',
  comovement: 'Spearman rank correlation rho(our-criteria%, unit-test%) >= 0.80 across the spectrum (>=4 points)',
  noFalseGreen: 'no install scores our-criteria >= 90% while unit-tests < 80% (criteria must not bless an install the fine suite fails)',
  directionality: 'every degraded install scores strictly below the original on BOTH signals (both detect every regression)',
  minPoints: 4,
};

const points = labels.map((label) => {
  const sc = JSON.parse(readFileSync(join(runsDir, label, 'score', 'scorecard.json'), 'utf8'));
  const c = sc.dimension1_fidelity.ourCriteria;
  const t = sc.dimension1_fidelity.projectTests;
  return {
    label,
    criteria: { passed: c.passed, N: c.N, pct: c.N ? c.passed / c.N : 0, hardGateFailed: c.hardGateFailed },
    tests: { passed: t.passed, M: t.M, pct: t.M ? t.passed / t.M : 0, status: t.status },
    successfulInstall: sc.composition.successfulInstall,
  };
});

// ---- Spearman rank correlation (average-rank ties) -------------------------
function avgRanks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1; // average rank (1-based)
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}
function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}
const cPct = points.map((p) => p.criteria.pct);
const tPct = points.map((p) => p.tests.pct);
const rho = pearson(avgRanks(cPct), avgRanks(tPct));

// ---- evaluate the bar ------------------------------------------------------
const base = points.find((p) => p.label === baseline);
const degraded = points.filter((p) => p.label !== baseline);
const clauses = {
  yardstick: !!base && base.criteria.pct === 1 && base.tests.pct === 1,
  comovement: rho != null && rho >= 0.80,
  noFalseGreen: !points.some((p) => p.criteria.pct >= 0.90 && p.tests.pct < 0.80),
  directionality: degraded.every((p) => p.criteria.pct < base.criteria.pct && p.tests.pct < base.tests.pct),
  enoughPoints: points.length >= BAR.minPoints,
};
const tracks = Object.values(clauses).every(Boolean);
const verdict = tracks ? 'TRACKS' : 'DOES-NOT-TRACK';

const readout = {
  schemaVersion: 1,
  stage: 'calibration',
  target: 'oh-my-logo',
  acceptanceBar: BAR,
  determinismNote: 'Calibration installs are deterministic code variants → one exact score each (the §4 N=5 averaging is for non-deterministic LLM installs).',
  baseline,
  points,
  spearmanRho: rho == null ? null : Number(rho.toFixed(3)),
  clauses,
  verdict,
};
writeFileSync(outPath, JSON.stringify(readout, null, 2) + '\n');

const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
console.log('\n===================== CALIBRATION READOUT (our-criteria vs unit-tests) =====================');
console.log('install                      our-criteria        unit-tests     install');
for (const p of points) {
  console.log(
    `  ${p.label.padEnd(26)} ${String(p.criteria.passed + '/' + p.criteria.N).padStart(5)} ${pct(p.criteria.pct)}   ` +
    `${String(p.tests.passed + '/' + p.tests.M).padStart(7)} ${pct(p.tests.pct)}   ${p.successfulInstall ? 'OK' : 'NOT-OK'}`
  );
}
console.log(`\nSpearman rho(criteria%, tests%) = ${readout.spearmanRho}`);
console.log('Acceptance bar (stated):');
for (const [k, v] of Object.entries(BAR)) if (k !== 'minPoints') console.log(`  - ${k}: ${v}`);
console.log('Bar clauses:');
for (const [k, v] of Object.entries(clauses)) console.log(`  [${v ? 'PASS' : 'FAIL'}] ${k}`);
console.log(`\nVERDICT: our-criteria ${verdict} the unit-test score on oh-my-logo.`);
console.log('============================================================================================\n');
