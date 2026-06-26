#!/usr/bin/env node
// Scorecard merger (Chunk 2, §6 — "one scorecard.json merging the fidelity sections +
// the essence/code-copy measure + a failure attribution per miss"; §5 score/ outputs).
//
// Reads the four section results from <scoreDir>/evidence/ and merges them into one
// score/scorecard.json, applying the COMPOSITION RULE (a hard-gate failure ⇒ "not a
// successful install" regardless of other sections; otherwise sections report
// independently, project-tests as the high-resolution headline and our-criteria as the
// cross-target-uniform headline) and a per-miss FAILURE ATTRIBUTION into the five §6
// categories. Attribution is heuristic (named as such): it cross-references the seed
// text and the project tests — full judgment-based attribution is a later chunk.
//
// Usage: emit-scorecard.mjs <evalDir> <scoreDir> <seedDir> <label> <timestamp> <rebuildDir> <envType> <image> <buildOk>

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeComposite } from './composite-score.mjs';

const [evalDir, scoreDir, seedDir, label, timestamp, rebuildDir, envType, image, buildOkRaw] = process.argv.slice(2);
if (!evalDir || !scoreDir || !seedDir) {
  console.error('usage: emit-scorecard.mjs <evalDir> <scoreDir> <seedDir> <label> <timestamp> <rebuildDir> <envType> <image> <buildOk>');
  process.exit(2);
}
const buildOk = buildOkRaw === 'true';
const evid = join(scoreDir, 'evidence');
const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const criteria = readJSON(join(evid, 'criteria.json'));
const tests = readJSON(join(evid, 'tests.json'));
const visual = readJSON(join(evid, 'visual.json'));
const codeCopy = readJSON(join(evid, 'code-copy.json'));

// seed text (lowercased) for attribution cross-reference
let seedText = '';
function collectSeed(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collectSeed(full);
    else if (/\.(md|markdown|txt)$/i.test(e.name)) seedText += '\n' + readFileSync(full, 'utf8').toLowerCase();
  }
}
collectSeed(seedDir);

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'via', 'its', 'are', 'has', 'including', 'clear', 'produces', 'output', 'argument', 'name', 'fails', 'error', 'state', 'contract', 'action', 'core', 'built']);
function keywordsFor(c) {
  const kws = new Set();
  for (const w of (c.id || '').split('-')) if (w.length >= 4) kws.add(w.toLowerCase());
  for (const s of c.check?.stdoutContains || []) kws.add(String(s).toLowerCase());
  for (const s of c.check?.stderrContains || []) kws.add(String(s).toLowerCase());
  for (const a of c.check?.argv || []) if (!String(a).startsWith('-') && String(a).length >= 4) kws.add(String(a).toLowerCase());
  for (const w of (c.description || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) if (!STOP.has(w)) kws.add(w);
  return [...kws];
}

// ---- failure attribution (heuristic; one entry per miss) -------------------
const projectTestsGreen = tests && tests.status === 'green';
const attribution = [];
if (criteria) {
  for (const r of criteria.results.filter((x) => !x.pass)) {
    const critDef = { id: r.id, description: r.description, check: r.check || {} };
    let category, rationale;
    if (!buildOk) {
      category = 'installer-failure';
      rationale = 'install did not build — the artifact, not the seed, is at fault.';
    } else if (projectTestsGreen) {
      category = 'oracle-overreach';
      rationale = "our criterion failed while the project's own tests are fully green — the criterion likely asserts beyond the real contract.";
    } else {
      const kws = keywordsFor(critDef);
      const mentioned = kws.filter((k) => seedText.includes(k));
      if (mentioned.length) {
        category = 'installer-failure';
        rationale = `the seed conveys this behavior (mentions: ${mentioned.slice(0, 4).join(', ')}) but the install does not satisfy it.`;
      } else {
        category = 'seed-omission';
        rationale = 'the behavior is absent from the seed text — the seed did not capture it.';
      }
    }
    attribution.push({ miss: r.id, section: 'our-criteria', tier: r.tier, category, reasons: r.reasons, rationale });
  }
}
if (tests && tests.status !== 'green') {
  let category, rationale;
  if (!buildOk) { category = 'installer-failure'; rationale = 'install did not build — project tests could not run.'; }
  else if (tests.status === 'test_setup_failure') { category = 'environment-limitation'; rationale = 'the install lacks the test runner/devDeps — tests could not be set up.'; }
  else { category = 'installer-failure'; rationale = `${tests.failed} project test(s) failed against the install (the held-out contract was not reproduced).`; }
  attribution.push({ miss: 'project-tests', section: 'project-tests', category, score: tests.score, rationale });
}

// ---- composite TREND score (scoring redirect) ------------------------------
// ONE weighted number per run = roll-up of the per-project recipe's component signals.
// No gates: "does it build/run" is a heavily-weighted INPUT (the `build` component), never
// an artificial zero. A component whose harness could not run is EXCLUDED (weights
// renormalize) and surfaced under harness[] — a harness failure never tanks the trend.
const manifest = readJSON(join(evalDir, 'eval.json')) || {};
const DEFAULT_SCORING = {
  note: 'built-in default recipe (tests-dominated); used when eval.json has no scoring block.',
  components: [
    { key: 'projectTests', label: 'held-out project tests', weight: 0.55, metric: 'ratio', evidence: 'tests.json', num: 'passed', den: 'M', harnessGuard: 'tests' },
    { key: 'build', label: 'does it build/run', weight: 0.20, metric: 'build' },
    { key: 'ourCriteria', label: 'our behavioral criteria', weight: 0.10, metric: 'ratio', evidence: 'criteria.json', num: 'passed', den: 'N' },
    { key: 'visual', label: 'terminal-output match', weight: 0.10, metric: 'value', evidence: 'visual.json', field: 'meanSimilarity' },
    { key: 'codeCopy', label: 'seed essence (not a source-dump)', weight: 0.05, metric: 'boolPenalty', evidence: 'code-copy.json', field: 'flagged' },
  ],
};
const usingDefaultRecipe = !(manifest.scoring && Array.isArray(manifest.scoring.components) && manifest.scoring.components.length);
const scoring = usingDefaultRecipe ? DEFAULT_SCORING : manifest.scoring;

// ONE shared computation (composite-score.mjs) — byte-identical with the macos lane, no drift.
const comp = computeComposite({ scoring, evidenceDir: evid, buildOk });
const compositeScore = comp.composite01 == null ? 0 : comp.composite01;
const presentWeight = comp.weightPresent;
const components = comp.components.map((c) => ({
  key: c.key, label: c.label, weight: c.weight, metric: c.metric, present: c.present,
  normalized: c.present ? Number(c.signal.toFixed(4)) : 0, raw: c.detail, contribution: c.contribution,
}));
const harnessFailures = comp.components.filter((c) => c.harnessExcluded)
  .map((c) => ({ component: c.key, status: c.harnessStatus, note: c.harnessNote, excludedFromComposite: true }));

const scorecard = {
  schemaVersion: 2,
  target: manifest.name || null,
  label: label || null,
  timestamp: timestamp || null,
  environment: { type: envType || null, image: image || null },
  rebuildDir: rebuildDir || null,
  seedDir,
  // THE trend number + how it was rolled up
  composite: {
    score: Number(compositeScore.toFixed(4)),
    weightPresent: Number(presentWeight.toFixed(4)),
    recipe: usingDefaultRecipe ? 'built-in default' : 'eval.json scoring',
    note: 'ONE weighted TREND number (0..1) over the present components — trend signal, NOT pass/fail; no gates. Harness-failed components are excluded (weights renormalize) and listed under harness[].',
    components,
  },
  // the visible BREAKDOWN — every component's full evidence is shown
  breakdown: {
    projectTests: tests,
    ourCriteria: criteria,
    visual,
    codeCopy,
    build: { ok: buildOk },
  },
  // setup/harness failures as their own visible component (§5) — never folded into fidelity
  harness: harnessFailures,
  buildOk,
  attribution,
  evidence: {
    dir: 'score/evidence',
    files: existsSync(evid) ? readdirSync(evid).sort() : [],
  },
};

writeFileSync(join(scoreDir, 'scorecard.json'), JSON.stringify(scorecard, null, 2) + '\n');

console.log('\n==================== SCORECARD (composite trend) ====================');
console.log(`composite TREND score: ${(compositeScore * 100).toFixed(1)}%   (weighted roll-up; trend signal, NOT pass/fail)`);
for (const r of components) {
  console.log(`  ${r.present ? '•' : '·'} ${String(r.key).padEnd(13)} w=${r.weight.toFixed(2)}  ${r.present ? `signal ${(r.normalized * 100).toFixed(0)}% (${r.raw}) → +${r.contribution.toFixed(3)}` : `EXCLUDED (${r.raw})`}`);
}
if (harnessFailures.length) {
  console.log('  harness failures (excluded from composite, shown separately):');
  for (const h of harnessFailures) console.log(`    ⚠ ${h.component}: ${h.status}`);
}
console.log(`  breakdown    : tests ${tests ? tests.passed + '/' + tests.M + ' [' + tests.status + ']' : 'n/a'} | our-criteria ${criteria ? criteria.passed + '/' + criteria.N : 'n/a'} | visual ${visual ? visual.meanSimilarity : 'n/a'} | code-copy ${codeCopy ? codeCopy.verdict : 'n/a'} | build ${buildOk ? 'ok' : 'NO'}`);
console.log(`  attribution  : ${attribution.length} miss(es) — ${[...new Set(attribution.map((a) => a.category))].join(', ') || 'none'}`);
console.log('=====================================================================\n');
