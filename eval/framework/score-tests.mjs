#!/usr/bin/env node
// project-tests scorer (Chunk 2, §6 dimension 1 — "project tests → X/M"). Parses the
// vitest JSON produced by running the HELD-OUT tests-locked/ copy against the installed
// artifact's module surface (the overlay assembled by evaluate.sh). Present only where
// the project has tests. A missing/failed report is recorded as a setup failure (a
// harness-indicting class), never silently 0.
//
// Usage: score-tests.mjs <reportPath> <buildOk> <containerWorkdir> <expectedM> <outPath>
// Writes <outPath> (project-tests results). Exit 0 always (data, not script error).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';

const [reportPath, buildOkRaw, containerWorkdir, expectedMRaw, outPath] = process.argv.slice(2);
if (!reportPath || !outPath) {
  console.error('usage: score-tests.mjs <reportPath> <buildOk> <containerWorkdir> <expectedM> <outPath>');
  process.exit(2);
}
const buildOk = buildOkRaw === 'true';
const expectedM = expectedMRaw ? Number(expectedMRaw) : null;
const cwd = containerWorkdir || '/work';

function write(o) { writeFileSync(outPath, JSON.stringify(o, null, 2) + '\n'); }
// `present` = "this is a real test RESULT that should roll into the composite". A HARNESS
// failure (couldn't run the suite at all) sets present:false + harnessFailure:true so the
// composite EXCLUDES it and the Evaluator surfaces it as its own visible component — a
// harness failure must never tank the trend number as if the install scored 0% (scoring
// redirect §5). The Evaluator brings its own test runner, so a missing-devDep setup failure
// should no longer occur; this stays as a backstop for genuine harness/compat failures.
const base = { section: 'project-tests', expectedM };

if (!buildOk) {
  write({ ...base, present: false, harnessFailure: true, status: 'build_failed', M: expectedM, passed: 0, failed: null, score: 0, byFile: [], note: 'install did not build — tests could not run (harness failure; the build component already reflects the no-build).' });
  console.log('[tests] build failed — project tests could not run (harness failure).');
  process.exit(0);
}
if (!existsSync(reportPath)) {
  write({ ...base, present: false, harnessFailure: true, status: 'test_setup_failure', M: expectedM, passed: 0, failed: null, score: 0, byFile: [], note: 'no vitest report — the held-out suite could not run against this install even with the scorer-supplied runner (harness/compat failure).' });
  console.log('[tests] no test report — harness failure.');
  process.exit(0);
}

let report;
try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
catch (e) {
  write({ ...base, present: false, harnessFailure: true, status: 'unparseable_report', M: expectedM, passed: 0, failed: null, score: 0, byFile: [], note: `report not JSON: ${e.message}` });
  process.exit(0);
}

const M = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const pending = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
const suitesFailed = report.numFailedTestSuites ?? 0;
const byFile = (report.testResults || []).map((r) => ({
  file: posix.relative(cwd, r.name),
  status: r.status,
  passed: (r.assertionResults || []).filter((a) => a.status === 'passed').length,
  failed: (r.assertionResults || []).filter((a) => a.status === 'failed').length,
})).sort((a, b) => a.file.localeCompare(b.file));

const allGreen = M > 0 && passed === M && failed === 0 && suitesFailed === 0 && pending === 0 && todo === 0;
write({
  ...base,
  present: true, harnessFailure: false,
  status: allGreen ? 'green' : 'tests_failed',
  M, passed, failed, pending, todo, suitesFailed,
  score: M ? passed / M : 0,
  expectedMatch: expectedM == null ? null : M === expectedM,
  byFile,
});
console.log(`[tests] project-tests: ${passed}/${M} passed (${failed} failed, ${suitesFailed} suite(s) failed)`);
