#!/usr/bin/env node
// Setup green-gate + report emitter (Chunk 1, §4-Setup).
//
// Parses the project's own test report (vitest JSON) to assert the ORIGINAL is
// fully green — a run is only trustworthy if Setup is green — then assembles
// oracle/setup.json from the captured-reference dir + the held-out test snapshot
// already produced by setup.sh. Green requires EVERY test to PASS (skipped/pending/
// todo are NOT green), mirroring the proven baseline gate.
//
// Usage: setup-report.mjs <evalDir> <reportPath> <containerWorkdir> <sha> <image> <buildOk> <expectedCount> <timestamp>
// Exit: 0 = green (setup.json status=green); 2 = tests not fully green; 4 = build failed / no usable report.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

const [evalDir, reportPath, containerWorkdir, sha, image, buildOkRaw, expectedCountRaw, timestamp, criteriaResultPath] = process.argv.slice(2);
if (!evalDir || !reportPath || !containerWorkdir) {
  console.error('usage: setup-report.mjs <evalDir> <reportPath> <containerWorkdir> <sha> <image> <buildOk> <expectedCount> <timestamp>');
  process.exit(2);
}
const buildOk = buildOkRaw === 'true';
const expectedCount = expectedCountRaw ? Number(expectedCountRaw) : null;
const oracleDir = join(evalDir, 'oracle');

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  })(dir);
  return out.sort();
}

const referenceFiles = listFiles(join(oracleDir, 'reference')).filter((f) => f !== 'index.json');
const testsLockedFiles = listFiles(join(oracleDir, 'tests-locked'));

const base = {
  schemaVersion: 1,
  stage: 'setup',
  target: require_name(),
  sha: sha || null,
  image: image || null,
  timestamp: timestamp || null,
  build: { ok: buildOk },
  reference: { dir: 'oracle/reference', captures: referenceFiles },
  testsLocked: { dir: 'oracle/tests-locked', files: testsLockedFiles, count: testsLockedFiles.length },
};
function require_name() {
  try { return JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')).name; } catch { return null; }
}
function write(rep) { writeFileSync(join(oracleDir, 'setup.json'), JSON.stringify(rep, null, 2) + '\n'); }
function loud(msg) {
  console.error('\n========================================================');
  console.error(`[setup] GREEN-GATE FAIL: ${msg}`);
  console.error('========================================================\n');
}

if (!buildOk) {
  write({ ...base, green: false, status: 'build_failed', oracleGreen: null });
  loud('the original failed to build — cannot establish a green yardstick. See container.log.');
  process.exit(4);
}

if (!existsSync(reportPath)) {
  write({ ...base, green: false, status: 'no_test_report', oracleGreen: null });
  loud(`no test report at ${reportPath} — tests never produced results.`);
  process.exit(4);
}
let report;
try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
catch (e) {
  write({ ...base, green: false, status: 'unparseable_test_report', oracleGreen: null });
  loud(`test report is not valid JSON: ${e.message}`);
  process.exit(4);
}

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const suitesFailed = report.numFailedTestSuites ?? 0;
const pending = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
const notRun = Math.max(0, total - passed - failed);
const files = (report.testResults || []).map((r) => posix.relative(containerWorkdir, r.name)).sort();

// GREEN = every test PASSED (not merely "not failed"); skip/pending/todo are not green.
const green = total > 0 && passed === total && failed === 0 && suitesFailed === 0 && pending === 0 && todo === 0 && notRun === 0;
const countMatch = expectedCount == null || total === expectedCount;

// OUR criteria on the known-good original (Chunk 3): if a criteria result was produced,
// Setup must ALSO confirm it's fully green (all pass, no hard-gate fail) — else broken
// criteria would ship inside a green setup.json.
let ourCriteria = null, ourCriteriaGreen = true, ourCriteriaChecked = false;
if (criteriaResultPath && existsSync(criteriaResultPath)) {
  ourCriteriaChecked = true;
  try {
    const cr = JSON.parse(readFileSync(criteriaResultPath, 'utf8'));
    ourCriteriaGreen = cr.N > 0 && cr.passed === cr.N && !cr.hardGateFailed;
    ourCriteria = { N: cr.N, passed: cr.passed, hardGateFailed: !!cr.hardGateFailed, green: ourCriteriaGreen, failed: (cr.results || []).filter((r) => !r.pass).map((r) => r.id) };
  } catch (e) { ourCriteriaGreen = false; ourCriteria = { green: false, error: `unparseable criteria result: ${e.message}` }; }
}

const oracleGreen = {
  signal: ourCriteriaChecked ? 'project-tests + our-criteria' : 'project-tests',
  total, passed, failed, suitesFailed, pending, todo, notRun,
  files,
  expectedCount, countMatch,
  green,
  ourCriteria,
};
const allGreen = green && countMatch && ourCriteriaGreen;
write({ ...base, green: allGreen, status: allGreen ? 'green' : 'not_green', oracleGreen });

console.log(`[setup] project tests: ${passed}/${total} passed (${failed} failed, ${pending} pending, ${todo} todo, ${suitesFailed} suite(s) failed)`);
if (ourCriteriaChecked) console.log(`[setup] our-criteria: ${ourCriteria.passed ?? '?'}/${ourCriteria.N ?? '?'} ${ourCriteriaGreen ? 'GREEN' : 'NOT GREEN'}${ourCriteria.failed && ourCriteria.failed.length ? ' — failing: ' + ourCriteria.failed.join(', ') : ''}`);
console.log(`[setup] reference captures: ${referenceFiles.length} | held-out test snapshot: ${testsLockedFiles.length} file(s)`);
if (expectedCount != null) console.log(`[setup] expected test count ${expectedCount}: ${countMatch ? 'MATCH' : `MISMATCH (got ${total})`}`);

if (!green) { loud(`oracle (project tests) NOT fully green — passed ${passed}/${total}, ${failed} failed, ${pending} pending, ${todo} todo, ${notRun} not-run.`); process.exit(2); }
if (!countMatch) { loud(`green, but ${total} tests != expected ${expectedCount} — manifest/pin drift; fix expectedTestCount or the pin.`); process.exit(2); }
if (!ourCriteriaGreen) { loud(`OUR criteria NOT fully green on the known-good original (${ourCriteria && ourCriteria.passed}/${ourCriteria && ourCriteria.N}${ourCriteria && ourCriteria.failed ? `, failing: ${ourCriteria.failed.join(', ')}` : ''}) — the oracle criteria are miscalibrated; fix oracle/criteria.json.`); process.exit(2); }

console.log(`[setup] GREEN. oracle/setup.json written (status=green, project-tests ${passed}/${total}${ourCriteriaChecked ? `, our-criteria ${ourCriteria.passed}/${ourCriteria.N}` : ''}).`);
process.exit(0);
