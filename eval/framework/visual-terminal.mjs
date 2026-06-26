#!/usr/bin/env node
// Visual-similarity scorer — the terminal-output lane (Chunk 2, §6 dimension 1 —
// "visual similarity vs oracle/reference/ → rubric verdict. Always present.").
// The docker lane's "visual" is the CLI's terminal output. Per §6 this is a BLINDED
// STRUCTURAL rubric, NOT a byte/pixel diff: ANSI is stripped and the install's output
// is compared to the reference on structural features (non-empty line count, total
// visible chars, and word-token overlap), yielding a per-capture similarity + verdict.
//
// Usage: visual-terminal.mjs <referenceDir> <installRefDir> <outPath>
//   referenceDir   = oracle/reference/   (original's captured evidence + index.json)
//   installRefDir  = the install's output on the SAME capture argv
// Writes <outPath> (visual results). Exit 0 always.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [referenceDir, installRefDir, outPath] = process.argv.slice(2);
if (!referenceDir || !installRefDir || !outPath) {
  console.error('usage: visual-terminal.mjs <referenceDir> <installRefDir> <outPath>');
  process.exit(2);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => s.replace(ANSI, '');
const normalize = (s) => stripAnsi(s).replace(/[ \t]+$/gm, '');
const nonEmptyLines = (s) => s.split('\n').filter((l) => l.trim().length);
const tokens = (s) => new Set(normalize(s).toLowerCase().match(/[a-z0-9#→._-]+/g) || []);
const visibleChars = (s) => normalize(s).replace(/\s/g, '').length;

function ratio(a, b) { const m = Math.max(a, b); return m === 0 ? 1 : 1 - Math.abs(a - b) / m; }
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const index = JSON.parse(readFileSync(join(referenceDir, 'index.json'), 'utf8'));
const perCapture = [];
for (const cap of index.captures) {
  const refPath = join(referenceDir, cap.file);
  const instPath = join(installRefDir, cap.file);
  if (!existsSync(refPath)) continue;
  const ref = readFileSync(refPath, 'utf8');
  const inst = existsSync(instPath) ? readFileSync(instPath, 'utf8') : '';
  const lineSim = ratio(nonEmptyLines(ref).length, nonEmptyLines(inst).length);
  const charSim = ratio(visibleChars(ref), visibleChars(inst));
  const tokSim = jaccard(tokens(ref), tokens(inst));
  const similarity = Number(((lineSim + charSim + tokSim) / 3).toFixed(3));
  const verdict = similarity >= 0.9 ? 'match' : similarity >= 0.5 ? 'partial' : 'mismatch';
  perCapture.push({
    id: cap.id, file: cap.file, verdict, similarity,
    features: {
      refLines: nonEmptyLines(ref).length, installLines: nonEmptyLines(inst).length,
      refChars: visibleChars(ref), installChars: visibleChars(inst),
      lineSim: Number(lineSim.toFixed(3)), charSim: Number(charSim.toFixed(3)), tokenSim: Number(tokSim.toFixed(3)),
    },
  });
  console.log(`[visual] ${verdict} (${similarity}) ${cap.id}`);
}

const n = perCapture.length;
const mean = n ? perCapture.reduce((a, c) => a + c.similarity, 0) / n : 0;
const anyMismatch = perCapture.some((c) => c.verdict === 'mismatch');
const allMatch = n > 0 && perCapture.every((c) => c.verdict === 'match');
const verdict = allMatch ? 'match' : anyMismatch ? 'mismatch' : 'partial';

writeFileSync(outPath, JSON.stringify({
  section: 'visual', present: true, modality: 'terminal-output', method: 'blinded-structural (ANSI-stripped; line/char/token features, not byte-diff)',
  verdict, meanSimilarity: Number(mean.toFixed(3)), perCapture,
}, null, 2) + '\n');
console.log(`[visual] overall: ${verdict} (mean similarity ${mean.toFixed(3)} over ${n} capture(s))`);
