#!/usr/bin/env node
// Baseline result parser + emitter (Chunk 2).
//
// Reads the vitest JSON report produced by container O, cross-checks the test
// files vitest actually ran against the oracle manifest (oracle.expected.testFiles),
// and writes runs/run-<id>/baseline.json. Reuses Chunk 1's loadConfig() so the
// same validated config drives the baseline.
//
// Exit codes (LOUD, no fallbacks):
//   0 = baseline green AND manifest matches
//   2 = suite not fully green (oracle invalid — abort the run)
//   3 = manifest divergence (vitest ran a different set than the manifest claims)
//   4 = no/!usable vitest report (install/build/test never produced results)
//
// Usage: emit-baseline.mjs <target> <runDir> <workspace> <containerWorkdir> <containerRC> <runId> <timestamp>
//
// `workspace` is the HOST path holding vitest-report.json; `containerWorkdir` is
// the mount point INSIDE container O (e.g. /work) that vitest's report paths are
// absolute against — test names must be relativized against the latter, not the host.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadConfig } from './load-config.mjs';

const [target, runDir, workspace, containerWorkdir, containerRCRaw, runId, timestamp] = process.argv.slice(2);
if (!target || !runDir || !workspace || !containerWorkdir) {
  console.error('usage: emit-baseline.mjs <target> <runDir> <workspace> <containerWorkdir> <containerRC> <runId> <timestamp>');
  process.exit(1);
}
const containerRC = Number(containerRCRaw);

function loud(msg) {
  console.error('\n========================================================');
  console.error(`[baseline] ABORT: ${msg}`);
  console.error('========================================================\n');
}

const cfg = loadConfig(target); // throws ConfigError on bad config
const reportPath = join(workspace, 'vitest-report.json');

function write(baseline) {
  writeFileSync(join(runDir, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
}

const base = {
  schemaVersion: 1,
  target: cfg.name,
  runId,
  timestamp: timestamp || null,
  source: { repoUrl: cfg.source.repoUrl, ref: cfg.source.ref, sha: cfg.source.sha },
  baseImage: cfg.baseImage,
  commands: { install: cfg.commands.install, build: cfg.commands.build, test: cfg.oracle.testCommand },
  container: { exitCode: containerRC },
};

// (4) No usable report → install/build/test failed before producing results.
if (!existsSync(reportPath)) {
  write({ ...base, green: false, status: 'no_test_report', tests: null, manifest: null });
  loud(`no vitest report at ${reportPath} — install/build/test failed (container exit ${containerRC}). See container.log.`);
  process.exit(4);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  write({ ...base, green: false, status: 'unparseable_test_report', tests: null, manifest: null });
  loud(`vitest report is not valid JSON: ${e.message}`);
  process.exit(4);
}

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const suitesFailed = report.numFailedTestSuites ?? 0;
const pending = report.numPendingTests ?? 0; // skipped / it.skip / describe.skip
const todo = report.numTodoTests ?? 0; // it.todo
// Anything counted but neither passed nor failed (skip/pending/todo) — defensive
// against schema drift so a "not run" test can never be silently treated as green.
const notRun = Math.max(0, total - passed - failed);

// vitest report paths are container-absolute (e.g. /work/__tests__/lib.test.ts);
// relativize against the container workdir (posix), NOT the host workspace.
const discovered = (report.testResults || [])
  .map((r) => posix.relative(containerWorkdir, r.name))
  .sort();
const expected = [...cfg.oracle.expected.testFiles].sort();
const missing = expected.filter((f) => !discovered.includes(f));
const extra = discovered.filter((f) => !expected.includes(f));
const manifestMatch = missing.length === 0 && extra.length === 0;

// GREEN requires every test to have actually PASSED — not merely "not failed".
// passed===total catches skip/pending/todo (which inflate total but not passed);
// the explicit pending/todo/notRun===0 checks are belt-and-suspenders vs schema drift.
const green =
  containerRC === 0 &&
  total > 0 &&
  passed === total &&
  failed === 0 &&
  suitesFailed === 0 &&
  pending === 0 &&
  todo === 0 &&
  notRun === 0;

const baseline = {
  ...base,
  green,
  status: green ? 'green' : 'not_green',
  tests: { total, passed, failed, suitesFailed, pending, todo, notRun, files: discovered },
  manifest: { expected, discovered, match: manifestMatch, missing, extra },
};
write(baseline);

console.log(
  `[baseline] tests: ${passed}/${total} passed ` +
    `(${failed} failed, ${pending} pending/skipped, ${todo} todo, ${suitesFailed} suite(s) failed)`
);
console.log(`[baseline] manifest: ${manifestMatch ? 'MATCH' : 'DIVERGENCE'} (${discovered.length} files ran vs ${expected.length} expected)`);

// (3) Manifest divergence — catch rot at the pin, don't misread later as low fidelity.
if (!manifestMatch) {
  loud(
    `vitest ran a different set of test files than the manifest claims.\n` +
      `  missing (expected, not run): ${missing.join(', ') || '(none)'}\n` +
      `  extra (ran, not in manifest): ${extra.join(', ') || '(none)'}\n` +
      `  → the oracle manifest is suspect at this SHA; fix targets/${target}/config.json.`
  );
  process.exit(3);
}

// (2) Not fully green — a non-green oracle is invalid; abort loudly, no fallback.
// "Green" means EVERY test passed: skipped/pending/todo tests are NOT green
// (silently-skipped tests would otherwise let a degraded oracle pass).
if (!green) {
  loud(
    `oracle suite is NOT fully green at the pin — every test must PASS.\n` +
      `  passed ${passed}/${total}; ${failed} failed, ${pending} pending/skipped, ` +
      `${todo} todo, ${notRun} not-run, ${suitesFailed} suite(s) failed; container exit ${containerRC}.\n` +
      `  A non-green oracle is invalid — the run is aborted. See test.log / container.log.`
  );
  process.exit(2);
}

console.log(`[baseline] GREEN at the pin: ${passed}/${total}. baseline.json written to ${runDir}.`);
process.exit(0);
