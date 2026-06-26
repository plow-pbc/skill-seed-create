#!/usr/bin/env node
// our-criteria scorer (Chunk 2, §6 dimension 1 — "our behavioral criteria → X/N").
//
// Runs each criterion's machine-check against the INSTALLED artifact and tallies
// X/N. Chunk 2 defines the `cli` check type (the docker/CLI lane): run the built
// CLI with argv in the environment and assert over exit code + stdout/stderr.
// Hard gates (tier:"gate") whose failure forces the graded score to 0 are flagged
// (the composition rule is applied by emit-scorecard.mjs); their diagnostics are
// still reported.
//
// Usage: criteria-check.mjs <image> <artifactDir> <bin> <criteriaPath> <outPath>
// Writes <outPath> (criteria-results JSON). Exit 0 always (a failing criterion is
// data, not a script error); exit 2 on bad args / unrunnable.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [image, artifactDir, bin, criteriaPath, outPath] = process.argv.slice(2);
if (!image || !artifactDir || !bin || !criteriaPath || !outPath) {
  console.error('usage: criteria-check.mjs <image> <artifactDir> <bin> <criteriaPath> <outPath>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(criteriaPath, 'utf8'));

function runCli(argv) {
  try {
    const stdout = execFileSync(
      'docker',
      ['run', '--rm', '--network', 'bridge', '-v', `${artifactDir}:/work`, '-w', '/work', image, 'node', bin, ...argv],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { exit: 0, stdout, stderr: '' };
  } catch (e) {
    return { exit: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function evalCli(check) {
  const r = runCli(check.argv || []);
  const reasons = [];
  const nonEmptyLines = r.stdout.split('\n').filter((l) => l.trim().length).length;
  if (check.expectExit !== undefined && r.exit !== check.expectExit) reasons.push(`exit ${r.exit} != expected ${check.expectExit}`);
  if (check.expectExitNonZero && r.exit === 0) reasons.push(`expected non-zero exit, got 0`);
  if (check.stdoutNonEmpty && r.stdout.trim().length === 0) reasons.push('stdout empty');
  if (check.minLines !== undefined && nonEmptyLines < check.minLines) reasons.push(`stdout has ${nonEmptyLines} non-empty line(s) < minLines ${check.minLines}`);
  for (const s of check.stdoutContains || []) if (!r.stdout.includes(s)) reasons.push(`stdout missing "${s}"`);
  for (const s of check.stderrContains || []) if (!r.stderr.includes(s)) reasons.push(`stderr missing "${s}"`);
  if (check.stdoutMatches && !new RegExp(check.stdoutMatches).test(r.stdout)) reasons.push(`stdout !~ /${check.stdoutMatches}/`);
  return {
    pass: reasons.length === 0,
    reasons,
    observed: { exit: r.exit, stdoutLines: nonEmptyLines, stdoutBytes: Buffer.byteLength(r.stdout), stderrBytes: Buffer.byteLength(r.stderr) },
  };
}

const results = [];
for (const c of spec.criteria) {
  let outcome;
  if (c.check.type === 'cli') outcome = evalCli(c.check);
  else outcome = { pass: false, reasons: [`unsupported check type "${c.check.type}"`], observed: {} };
  results.push({ id: c.id, tier: c.tier, category: c.category, description: c.description, check: c.check, ...outcome });
  console.log(`[criteria] ${outcome.pass ? 'PASS' : 'FAIL'} [${c.tier}] ${c.id}${outcome.pass ? '' : ' — ' + outcome.reasons.join('; ')}`);
}

const N = results.length;
const passed = results.filter((r) => r.pass).length;
const gateResults = results.filter((r) => r.tier === 'gate');
const gateFailed = gateResults.filter((r) => !r.pass).map((r) => r.id);
const gradedResults = results.filter((r) => r.tier === 'graded');

// NO GATES (scoring redirect): our-criteria is a plain ratio passed/N that rolls into the
// composite trend number as ONE weighted component. A criterion tagged tier:"gate" is shown
// (informational, e.g. "does it render at all"), but it no longer FORCES the score to 0 —
// "does it run" is a heavily-weighted INPUT to the composite (the `build` component), not an
// artificial zero. We keep the gate/graded tallies purely as diagnostics.
const out = {
  section: 'our-criteria',
  criteriaFile: criteriaPath,
  N,
  passed,
  score: N ? passed / N : null,
  gates: { total: gateResults.length, passed: gateResults.filter((r) => r.pass).length, failed: gateFailed, note: 'informational only — no gate forces the score (scoring redirect)' },
  graded: { total: gradedResults.length, passed: gradedResults.filter((r) => r.pass).length },
  results,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`[criteria] our-criteria: ${passed}/${N} (gate-tagged ${out.gates.passed}/${out.gates.total} — informational, no gating)`);
