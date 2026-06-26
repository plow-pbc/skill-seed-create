#!/usr/bin/env node
// Composite TREND-number computer (the "scoring redirect" consumer). Rolls an eval's
// scoring.components[] (from eval.json, resolved by dispatch as cfg.scoring) into ONE
// composite number per run — a weighted average over the PRESENT components, NO gates.
// Every component is also returned in a breakdown. A component whose signal cannot be
// measured is EXCLUDED and the remaining weights renormalize (a harness/build failure
// never tanks the trend; it is surfaced as its own visible component).
//
// Conforms to framework/schemas/eval.schema.json `scoring`:
//   metric "ratio"       → evidence[num]/evidence[den]            (den 0 / missing ⇒ absent)
//   metric "value"       → evidence[field] clamped to [0,1]       (missing ⇒ absent)
//   metric "build"       → buildOk ? 1 : 0                        (always present)
//   metric "boolPenalty" → evidence[field] truthy ? 0 : 1         (penalize, never zero whole)
//   harnessGuard "tests" → if evidence.status indicates the harness could not run
//                          (setup/build failure) the component is ABSENT (surfaced), not 0.
//
// Usage: composite-score.mjs <scoringJsonOrPath> <evidenceDir> <buildOk:true|false> <outPath>
//   <scoringJsonOrPath> = a path to a JSON file holding the scoring block, or inline JSON.
// Writes <outPath> (composite.json). Exit 0; exit 2 on bad args.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// The ONE composite-trend computation, shared by BOTH lanes (docker emit-scorecard imports
// computeComposite; the macos evaluate-macos.sh runs this as a CLI). Single source of truth →
// the number can't drift between lanes.
//   scoring     : the eval.json `scoring` block ({ note?, components[] }).
//   evidenceDir : dir holding the component evidence files (score/evidence).
//   buildOk     : whether the install built (the `build` metric input).
export function computeComposite({ scoring, evidenceDir, buildOk }) {
  if (!scoring || !Array.isArray(scoring.components)) throw new Error('computeComposite: scoring.components[] required');
  const readEvid = (name) => { const p = join(evidenceDir, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const breakdown = [];
  for (const c of scoring.components) {
    let signal = null, present = false, detail = '', harnessExcluded = false, harnessStatus = null, harnessNote = null;
    const ev = c.evidence ? readEvid(c.evidence) : null;
    // Harness guard: a test-harness that COULD NOT RUN ⇒ component ABSENT (surfaced), not a 0.
    // Honor BOTH the scorer's explicit flags (score-tests sets present:false / harnessFailure:true)
    // AND a status-string match — robust across lanes regardless of which signal a scorer emits.
    const harnessDown = c.harnessGuard === 'tests' && ev && (
      ev.harnessFailure === true || ev.present === false ||
      /setup_failure|build_fail|harness|unparseable/i.test(String(ev.status || ''))
    );
    if (harnessDown) {
      harnessExcluded = true; harnessStatus = ev.status || null; harnessNote = ev.note || null;
      detail = `harness could not run (status=${ev.status}) → excluded from the trend (surfaced)`;
    } else if (c.metric === 'build') {
      signal = buildOk ? 1 : 0; present = true; detail = `buildOk=${buildOk}`;
    } else if (c.metric === 'ratio') {
      const n = ev ? num(ev[c.num]) : null, d = ev ? num(ev[c.den]) : null;
      if (n !== null && d !== null && d > 0) { signal = Math.max(0, Math.min(1, n / d)); present = true; detail = `${n}/${d}`; }
      else detail = `ratio unmeasurable (${c.evidence}:${c.num}/${c.den})`;
    } else if (c.metric === 'value') {
      const v = ev ? num(ev[c.field]) : null;
      if (v !== null) { signal = Math.max(0, Math.min(1, v)); present = true; detail = `${c.field}=${v}`; }
      else detail = `value unmeasurable (${c.evidence}:${c.field})`;
    } else if (c.metric === 'boolPenalty') {
      if (ev && c.field in ev) { signal = ev[c.field] ? 0 : 1; present = true; detail = `${c.field}=${ev[c.field]} → ${signal}`; }
      else { signal = 1; present = true; detail = `${c.field} absent → no penalty`; }
    } else {
      detail = `unknown metric "${c.metric}"`;
    }
    breakdown.push({ key: c.key, label: c.label || c.key, weight: c.weight, metric: c.metric, present, signal, detail, harnessExcluded, harnessStatus, harnessNote });
  }

  const presentComps = breakdown.filter((b) => b.present);
  const wsum = presentComps.reduce((a, b) => a + b.weight, 0);
  const weighted = wsum > 0 ? presentComps.reduce((a, b) => a + b.weight * b.signal, 0) / wsum : null;
  for (const b of breakdown) b.contribution = b.present && wsum > 0 ? Number(((b.weight / wsum) * b.signal).toFixed(4)) : 0;
  const composite01 = weighted;
  return {
    schemaVersion: 1,
    kind: 'composite-trend',
    note: scoring.note || 'weighted average over present components; absent components renormalize; NO gates.',
    number: composite01 === null ? null : Math.round(100 * composite01), // 0..100 (macos lane's number)
    composite01,                                                          // 0..1  (docker scorecard.composite.score)
    weightPresent: Number(wsum.toFixed(4)),
    buildOk,
    excluded: breakdown.filter((b) => !b.present).map((b) => ({ key: b.key, why: b.detail })),
    components: breakdown,
  };
}

function main() {
  const [scoringArg, evidenceDir, buildOkRaw, outPath] = process.argv.slice(2);
  if (!scoringArg || !evidenceDir || !outPath) {
    console.error('usage: composite-score.mjs <scoringJsonOrPath> <evidenceDir> <buildOk> <outPath>');
    process.exit(2);
  }
  const buildOk = String(buildOkRaw) === 'true';
  let scoring;
  try { scoring = JSON.parse(existsSync(scoringArg) ? readFileSync(scoringArg, 'utf8') : scoringArg); }
  catch (e) { console.error('composite-score: bad scoring JSON: ' + e.message); process.exit(2); }
  let out;
  try { out = computeComposite({ scoring, evidenceDir, buildOk }); }
  catch (e) { console.error('composite-score: ' + e.message); process.exit(2); }
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  const present = out.components.filter((b) => b.present);
  console.log(`[composite] number = ${out.number === null ? 'n/a' : out.number} / 100  (over ${present.length}/${out.components.length} present components)`);
  for (const b of out.components) console.log(`  ${b.present ? '•' : '×'} ${b.key} w=${b.weight} ${b.present ? `signal=${b.signal.toFixed(3)} contrib=${b.contribution}` : `EXCLUDED (${b.detail})`}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
