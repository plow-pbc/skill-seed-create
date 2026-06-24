#!/usr/bin/env node
// Chunk 5 — classify the rebuild's oracle run into fidelity.json.
//
// Inputs (in runDir): reference-report.json (Run A: ORIGINAL src, must be N/N green —
// gives per-file denominators + validates the oracle env) and fidelity-report.json
// (Run B: REBUILT src bound at the moduleSurface mount). Emits fidelity.json =
// X/N passing + EVERY non-pass tagged by class. STRICT (inherited from Chunk 2):
// a skipped / not-collected oracle test against the rebuild is a real GAP, never a pass.
//
// Failure classes: build_failure | test_setup_failure | import_failure |
//                  assertion_failure | harness_failure.
// Only import/assertion are genuine SEED gaps; build/test_setup/harness indict the
// harness (per spec). We never fudge classification to flatter the number.
//
// Usage: emit-fidelity.mjs <target> <runDir> <scorerWorkspace> <rebuildDir>
// Exit: 0 wrote fidelity.json; 2 reference (oracle env) not green / cross-check fail
//       (the fidelity number would be invalid); 4 no/unusable reports (harness).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './load-config.mjs';

const [target, runDir, workspace, rebuildDir] = process.argv.slice(2);
if (!target || !runDir || !workspace || !rebuildDir) {
  console.error('usage: emit-fidelity.mjs <target> <runDir> <scorerWorkspace> <rebuildDir>');
  process.exit(1);
}
const cfg = loadConfig(target);
const mount = cfg.moduleSurface?.mountPoint || 'src';
const expected = [...(cfg.oracle?.expected?.testFiles || [])].sort();

// vitest wrote --outputFile=/work/*.json => inside the mounted scorer workspace.
const REF = join(workspace, 'reference-report.json');
const FID = join(workspace, 'fidelity-report.json');
function load(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
const ref = load(REF), fid = load(FID);
if (!ref) { console.error(`[fidelity] HARNESS FAULT: no/unreadable reference report ${REF}`); process.exit(4); }
if (!fid) { console.error(`[fidelity] HARNESS FAULT: no/unreadable fidelity report ${FID}`); process.exit(4); }

// vitest test-file path -> manifest-relative key (".../__tests__/x" -> "__tests__/x")
function fileKey(name) {
  const s = String(name || '');
  const i = s.indexOf('__tests__');
  return i >= 0 ? s.slice(i) : s.replace(/^.*\/work\//, '');
}

// ---- Run A (reference): per-file denominators + env validation -------------
const refFiles = {};
for (const tr of ref.testResults || []) {
  const k = fileKey(tr.name);
  refFiles[k] = (tr.assertionResults || []).length;
}
const refDiscovered = Object.keys(refFiles).sort();
const N = ref.numTotalTests ?? Object.values(refFiles).reduce((a, b) => a + b, 0);
const refPassed = ref.numPassedTests ?? 0;
const refGreen = N > 0 && refPassed === N && (ref.numFailedTests ?? 0) === 0;

// cross-check discovered vs expected manifest (8 files / N)
const crossOk = refDiscovered.length === expected.length && refDiscovered.every((f, i) => f === expected[i]);

if (!refGreen) {
  console.error(`[fidelity] ABORT: reference (ORIGINAL src) run is NOT green (${refPassed}/${N}) — the oracle env is invalid; the fidelity number would be meaningless (harness/test_setup, not a seed gap).`);
  // still write a record for audit
  writeFileSync(join(runDir, 'fidelity.json'), JSON.stringify({ schemaVersion: 1, target: cfg.name, error: 'reference_not_green', referenceGreen: refGreen, N, refPassed }, null, 2) + '\n');
  process.exit(2);
}
if (!crossOk) {
  console.error(`[fidelity] ABORT: discovered-vs-expected cross-check FAILED.\n  expected: ${expected.join(', ')}\n  discovered: ${refDiscovered.join(', ')}`);
  writeFileSync(join(runDir, 'fidelity.json'), JSON.stringify({ schemaVersion: 1, target: cfg.name, error: 'cross_check_failed', expected, discovered: refDiscovered }, null, 2) + '\n');
  process.exit(2);
}

// ---- classification --------------------------------------------------------
function classify(text, ran) {
  const t = String(text || '');
  // 1) module resolution failure (API surface absent) — e.g. ../src/utils/stdout.js
  if (/Failed to resolve import|Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|Could not resolve|Module not found|Missing "\.\//i.test(t)) return 'import_failure';
  // 2) genuine transpile/syntax error of the rebuilt src (NOT an assertion's "expected '…'")
  if (/SyntaxError|Transform failed|esbuild|Unexpected (token|identifier|end of)|Cannot use import statement|Failed to parse|Parsing error|Parse failure/i.test(t)) return 'build_failure';
  // 3) the test EXECUTED and failed/threw (behavior gap) — AssertionError, TypeError, etc.
  //    Checked BEFORE test_setup so an assertion that mentions "expected '…'" isn't mis-binned.
  if (ran || /AssertionError|TypeError|ReferenceError|is not a function|expected .* to (be|equal|match|throw|contain|have)|toBe|toEqual|toMatch|toThrow/i.test(t)) return 'assertion_failure';
  // 4) runner/devDeps/config provisioning fault (indicts the harness)
  if (/Cannot find module 'vitest'|No test files found|Vitest failed to|Failed to load (config|url)|devDependenc/i.test(t)) return 'test_setup_failure';
  return 'harness_failure';                         // a non-run failure we couldn't pin -> visible
}

const CLASSES = ['build_failure', 'test_setup_failure', 'import_failure', 'assertion_failure', 'harness_failure'];
const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0]));
const failures = [];
const perFile = [];

const fidByKey = {};
for (const tr of fid.testResults || []) fidByKey[fileKey(tr.name)] = tr;

let passedTotal = 0;
for (const f of refDiscovered) {
  const refCount = refFiles[f];
  const tr = fidByKey[f];
  let passed = 0;
  const fileClasses = {};
  const bump = (cls, n, sample) => { byClass[cls] += n; fileClasses[cls] = (fileClasses[cls] || 0) + n; if (sample) failures.push({ file: f, class: cls, sample: String(sample).slice(0, 200).replace(/\s+/g, ' ') }); };

  if (!tr) {
    // file vanished from the run entirely => not collected: all its tests are gaps.
    bump('import_failure', refCount, `file not present in fidelity run (not collected): ${f}`);
  } else {
    const ars = tr.assertionResults || [];
    for (const a of ars) {
      if (a.status === 'passed') { passed++; continue; }
      const ran = a.status === 'failed';            // failed = executed & failed; skipped/todo = not run
      const msg = (a.failureMessages || []).join('\n') || tr.message || `status=${a.status}`;
      bump(classify(msg, ran), 1, msg);
    }
    // tests that the reference had but this run did NOT even collect (partial/collection error)
    const notCollected = refCount - ars.length;
    if (notCollected > 0) {
      const cls = classify(tr.message, false);
      bump(cls === 'harness_failure' ? 'import_failure' : cls, notCollected, tr.message || `${notCollected} test(s) not collected in ${f}`);
    }
  }
  passedTotal += passed;
  perFile.push({ file: f, refCount, passed, gaps: refCount - passed, classes: fileClasses });
}

// ---- binding proof: the BOUND src is the REBUILD, not the original ---------
const boundSrc = join(workspace, mount);
const stdoutPresent = existsSync(join(boundSrc, 'utils', 'stdout.ts'));   // ORIGINAL had this
const colorsPresent = existsSync(join(boundSrc, 'utils', 'colors.ts'));   // REBUILD-only marker
const originalFiles = existsSync(join(runDir, 'original-src-filelist.txt')) ? readFileSync(join(runDir, 'original-src-filelist.txt'), 'utf8').trim().split('\n') : [];
const boundFiles = existsSync(join(runDir, 'bound-src-filelist.txt')) ? readFileSync(join(runDir, 'bound-src-filelist.txt'), 'utf8').trim().split('\n') : [];
const bindingProven = JSON.stringify(originalFiles) !== JSON.stringify(boundFiles); // surfaces differ => swapped

// Per spec §Metrics: only import/assertion are genuine SEED gaps; setup/harness
// indict the HARNESS; build_failure (rebuilt code won't transpile) is a RECONSTRUCTION
// defect — reported on its own, neither a behavior gap nor a harness fault.
const genuineSeedGaps = byClass.import_failure + byClass.assertion_failure;
const harnessIndicting = byClass.test_setup_failure + byClass.harness_failure;
const rebuildBuildDefects = byClass.build_failure;

const out = {
  schemaVersion: 1,
  target: cfg.name,
  rebuildDir,
  moduleSurfaceMount: mount,
  referenceGreen: refGreen,
  crossCheck: { expected, discovered: refDiscovered, match: crossOk, N },
  fidelity: { passed: passedTotal, total: N, pct: +(100 * passedTotal / N).toFixed(1) },
  byClass,
  genuineSeedGaps,        // import + assertion (real seed gaps, per spec)
  harnessIndicting,       // test_setup + harness (would indict the harness, not the seed)
  rebuildBuildDefects,    // build_failure (rebuilt code won't transpile — reconstruction defect)
  bindingProof: {
    bound: bindingProven,
    note: 'bound src/ = REBUILT module surface (not original). Original had utils/stdout.ts; rebuild has utils/colors.ts.',
    originalHadStdout: originalFiles.some((x) => /utils\/stdout\.ts$/.test(x)),
    boundHasStdout: stdoutPresent,
    boundHasColors: colorsPresent,
    originalSrcFiles: originalFiles,
    boundSrcFiles: boundFiles,
  },
  perFile,
  failures,
};
writeFileSync(join(runDir, 'fidelity.json'), JSON.stringify(out, null, 2) + '\n');

const sumClasses = CLASSES.reduce((a, c) => a + byClass[c], 0);
console.log(`[fidelity] reference: ${refPassed}/${N} green; cross-check ${crossOk ? 'OK' : 'FAIL'} (${refDiscovered.length} files)`);
console.log(`[fidelity] FIDELITY: ${passedTotal}/${N} (${out.fidelity.pct}%)`);
for (const c of CLASSES) console.log(`  ${c}: ${byClass[c]}`);
console.log(`  (genuine seed gaps = import+assertion = ${genuineSeedGaps}; harness-indicting = ${harnessIndicting})`);
console.log(`[fidelity] accounting: passed ${passedTotal} + failures ${sumClasses} = ${passedTotal + sumClasses} (must equal N=${N})`);
console.log(`[fidelity] binding proven (rebuilt src bound, not original): ${bindingProven} | boundHasStdout=${stdoutPresent} boundHasColors=${colorsPresent}`);
if (passedTotal + sumClasses !== N) console.error('[fidelity] WARNING: accounting != N — some tests unattributed (see perFile).');
console.log(`[fidelity] fidelity.json written to ${runDir}`);
process.exit(0);
