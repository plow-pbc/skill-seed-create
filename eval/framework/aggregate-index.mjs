#!/usr/bin/env node
// Multi-run aggregation → runs/index.json (Chunk 4, §4 multi-run + §5 index).
//
// A single install is non-deterministic and not decision-grade (proven: baseline runs
// spanned 33–43%), so runs execute N times (default 5) and aggregate. This rolls up
// every run under runs/ — its scores + leakage verdict + links — and reports mean ± stdev
// of the headline metrics over the VALID runs (INVALIDATED-by-leakage runs are excluded
// from the aggregate and reported separately; the orchestrator re-runs them).
//
// Usage: aggregate-index.mjs <runsDir> [<label> ...]   (no labels → discover all runs)
// Writes <runsDir>/index.json.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [runsDir, ...labels] = process.argv.slice(2);
if (!runsDir) { console.error('usage: aggregate-index.mjs <runsDir> [<label> ...]'); process.exit(2); }
const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const found = labels.length
  ? labels
  : readdirSync(runsDir).filter((d) => { try { return statSync(join(runsDir, d)).isDirectory() && existsSync(join(runsDir, d, 'score', 'scorecard.json')); } catch { return false; } }).sort();

const runs = [];
for (const label of found) {
  const dir = join(runsDir, label);
  const sc = readJSON(join(dir, 'score', 'scorecard.json'));
  if (!sc) continue;
  const leak = readJSON(join(dir, 'score', 'leakage-audit.json'));
  const bd = sc.breakdown || sc.dimension1_fidelity || {};   // schemaVersion 2 = breakdown; v1 = dimension1_fidelity
  const c = bd.ourCriteria, t = bd.projectTests, v = bd.visual;
  const cc = (sc.breakdown && sc.breakdown.codeCopy) || sc.dimension2_seedQuality?.codeCopy;
  const testsHarnessFailed = !!(t && (t.present === false || t.harnessFailure === true));
  runs.push({
    label,
    leakageVerdict: leak ? leak.verdict : 'not-audited',
    invalidated: leak ? leak.verdict === 'INVALIDATED' : false,
    scores: {
      // HEADLINE = the composite TREND number (scoring redirect). Older scorecards w/o it
      // fall back to null (excluded from the trend mean).
      composite: typeof sc.composite?.score === 'number' ? sc.composite.score : null,
      // component breakdowns (no gating; raw ratios). A test HARNESS failure is excluded from
      // the project-tests mean (it isn't a 0% fidelity result) — surfaced via harnessFailureRate.
      ourCriteriaPct: c ? (typeof c.score === 'number' ? c.score : (c.N ? c.passed / c.N : null)) : null,
      projectTestsPct: (t && t.M && !testsHarnessFailed) ? t.passed / t.M : null,
      visualSimilarity: v ? v.meanSimilarity : null,
      buildOk: typeof sc.buildOk === 'boolean' ? sc.buildOk : null,
      testsHarnessFailed,
      codeCopyFlagged: cc ? cc.flagged : null,
    },
    links: { scorecard: `${label}/score/scorecard.json`, runJson: `${label}/run.json`, evidence: `${label}/score/evidence` },
  });
}

const valid = runs.filter((r) => !r.invalidated);
function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number');
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  return { mean: Number(mean.toFixed(4)), stdev: Number(Math.sqrt(variance).toFixed(4)), n: v.length, min: Math.min(...v), max: Math.max(...v) };
}
const rate = (xs) => { const v = xs.filter((x) => typeof x === 'boolean'); return v.length ? Number((v.filter(Boolean).length / v.length).toFixed(4)) : null; };
const agg = {
  // THE headline: composite trend score, mean ± stdev over valid runs.
  compositeScore: stats(valid.map((r) => r.scores.composite)),
  // component trends (for diagnosing WHAT moved the number)
  ourCriteriaPct: stats(valid.map((r) => r.scores.ourCriteriaPct)),
  projectTestsPct: stats(valid.map((r) => r.scores.projectTestsPct)),
  visualSimilarity: stats(valid.map((r) => r.scores.visualSimilarity)),
  buildRate: rate(valid.map((r) => r.scores.buildOk)),
  testHarnessFailureRate: rate(valid.map((r) => r.scores.testsHarnessFailed)),
  sourceDumpRate: rate(valid.map((r) => (r.scores.codeCopyFlagged == null ? null : !!r.scores.codeCopyFlagged))),
};

const index = {
  schemaVersion: 2,
  runsDir,
  totalRuns: runs.length,
  validRuns: valid.length,
  invalidatedRuns: runs.filter((r) => r.invalidated).map((r) => r.label),
  headline: 'compositeScore',
  aggregate: agg,
  decisionGradeNote: 'compositeScore = the TREND signal (mean ± stdev over VALID runs; leakage-INVALIDATED excluded + re-run). Trend-tracking — is seed-create holding/improving — NOT pass/fail. Component means show WHAT moved the number; project-tests excludes harness-failed runs.',
  runs,
};
writeFileSync(join(runsDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

const pc = (s) => (s ? `${(s.mean * 100).toFixed(1)}% ± ${(s.stdev * 100).toFixed(1)} (n=${s.n}, [${(s.min * 100).toFixed(0)}–${(s.max * 100).toFixed(0)}])` : 'n/a');
console.log(`[index] ${runs.length} run(s); ${valid.length} valid, ${runs.length - valid.length} invalidated.`);
console.log(`[index] COMPOSITE TREND: ${pc(agg.compositeScore)}   ← headline`);
console.log(`[index]   ├ our-criteria  : ${pc(agg.ourCriteriaPct)}`);
console.log(`[index]   ├ project-tests : ${pc(agg.projectTestsPct)}  (harness-failed runs excluded)`);
console.log(`[index]   ├ visual        : ${agg.visualSimilarity ? agg.visualSimilarity.mean + ' ± ' + agg.visualSimilarity.stdev : 'n/a'}`);
console.log(`[index]   ├ build rate    : ${agg.buildRate == null ? 'n/a' : (agg.buildRate * 100).toFixed(0) + '%'}`);
console.log(`[index]   └ harness-fail  : ${agg.testHarnessFailureRate == null ? 'n/a' : (agg.testHarnessFailureRate * 100).toFixed(0) + '% of runs'}`);
console.log(`[index]   · source-dump  : ${agg.sourceDumpRate == null ? 'n/a' : (agg.sourceDumpRate * 100).toFixed(0) + '% of seeds flagged'}`);
console.log(`[index] written to ${join(runsDir, 'index.json')}`);
