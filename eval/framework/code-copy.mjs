#!/usr/bin/env node
// Essence-extraction / code-copy scorer (Chunk 2, §6 dimension 2 — "did the seed
// extract the essence, or just copy?"). Measures verbatim-code VOLUME in the seed:
//   (1) code-fence ratio  = fenced code lines / total non-blank lines
//   (2) verbatim blocks    = longest run of seed code-fence lines appearing CONTIGUOUSLY
//                            in some source/ file (line-level longest-common-substring),
//                            plus how many fenced lines appear verbatim in source at all.
// A source-dump is flagged as a BAD seed even if it rebuilds ("ship the seed, not the
// plant") — the framework must never reward dumping. Thresholds are a Chunk-2 deliverable
// (§11) and are recorded in the output so they're reviewable.
//
// Usage: code-copy.mjs <seedDir> <sourceDir> <outPath>
// Writes <outPath> (code-copy results). Exit 0 always.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const [seedDir, sourceDir, outPath] = process.argv.slice(2);
if (!seedDir || !sourceDir || !outPath) {
  console.error('usage: code-copy.mjs <seedDir> <sourceDir> <outPath>');
  process.exit(2);
}

// Tunable thresholds (Chunk-2 deliverable). A seed is flagged if EITHER trips.
const THRESHOLDS = {
  fenceRatioMax: 0.40,        // > 40% of the seed being fenced code = dump territory
  longestVerbatimBlockMax: 10, // a >=10-line contiguous verbatim match from source = a dump
  totalVerbatimLinesMax: 60,   // or >=60 fenced lines copied verbatim from source overall
  minBlockLines: 5,            // a "block" counts only if >= this many contiguous lines
};

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.swift', '.go', '.rs', '.py']);
const norm = (l) => l.replace(/\s+/g, ' ').trim();

function walk(dir, pred, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build'].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, base, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

// ---- (1) parse the seed: total non-blank lines + fenced code lines ----------
const seedFiles = walk(seedDir, (f) => /\.(md|markdown)$/i.test(f));
let totalNonBlank = 0;
const fencedLines = []; // {text, norm} for every non-blank line inside ``` fences
const unfencedSeq = []; // normalized non-blank lines OUTSIDE fences (catch unfenced dumps)
for (const f of seedFiles) {
  let inFence = false;
  for (const raw of readFileSync(f, 'utf8').split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (raw.trim().length === 0) continue;
    totalNonBlank++;
    if (inFence) fencedLines.push({ text: raw, norm: norm(raw) });
    else { const n = norm(raw); if (n.length >= 4) unfencedSeq.push(n); }
  }
}
const fenceRatio = totalNonBlank ? fencedLines.length / totalNonBlank : 0;

// ---- (2) verbatim-block detection vs source/ -------------------------------
// Compare the seed's fenced code lines (normalized, non-trivial) against each source
// file's lines via a line-level longest-common-substring (contiguity = a real dump).
const seedSeq = fencedLines.map((l) => l.norm).filter((s) => s.length >= 4);
const srcFiles = walk(sourceDir, (f) => CODE_EXT.has(extname(f)));
const srcLineSet = new Set();
let longest = { lines: 0, sourceFile: null, sample: [] };
let unfencedLongest = { lines: 0, sourceFile: null, sample: [] };
let blocksOverMin = 0;

function lcsSubstring(a, b) {
  // returns {len, aEnd} of the longest contiguous common run (line granularity)
  const m = a.length, n = b.length;
  let best = 0, bestAEnd = 0;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; bestAEnd = i; }
      }
    }
    prev = cur;
  }
  return { len: best, aEnd: bestAEnd };
}

for (const sf of srcFiles) {
  const srcSeq = readFileSync(sf, 'utf8').split('\n').map(norm).filter((s) => s.length >= 4);
  for (const s of srcSeq) srcLineSet.add(s);
  if (seedSeq.length) {
    const { len, aEnd } = lcsSubstring(seedSeq, srcSeq);
    if (len >= THRESHOLDS.minBlockLines) blocksOverMin++;
    if (len > longest.lines) {
      longest = { lines: len, sourceFile: relative(sourceDir, sf), sample: seedSeq.slice(aEnd - len, aEnd).slice(0, 4) };
    }
  }
  if (unfencedSeq.length) {
    const u = lcsSubstring(unfencedSeq, srcSeq);
    if (u.len > unfencedLongest.lines) {
      unfencedLongest = { lines: u.len, sourceFile: relative(sourceDir, sf), sample: unfencedSeq.slice(u.aEnd - u.len, u.aEnd).slice(0, 4) };
    }
  }
}
const totalVerbatimLines = seedSeq.filter((s) => srcLineSet.has(s)).length;
const unfencedVerbatimLines = unfencedSeq.filter((s) => srcLineSet.has(s)).length;

// ---- flag ------------------------------------------------------------------
const reasons = [];
if (fenceRatio > THRESHOLDS.fenceRatioMax) reasons.push(`code-fence ratio ${(fenceRatio * 100).toFixed(0)}% > ${(THRESHOLDS.fenceRatioMax * 100)}%`);
if (longest.lines >= THRESHOLDS.longestVerbatimBlockMax) reasons.push(`verbatim block of ${longest.lines} lines (>= ${THRESHOLDS.longestVerbatimBlockMax}) from ${longest.sourceFile}`);
if (totalVerbatimLines >= THRESHOLDS.totalVerbatimLinesMax) reasons.push(`${totalVerbatimLines} fenced lines copied verbatim from source (>= ${THRESHOLDS.totalVerbatimLinesMax})`);
// UNFENCED dumps: a dump pasted without ``` fences keeps fenceRatio low but is just as much
// a source-dump. Detect a long contiguous unfenced verbatim run, or high unfenced verbatim volume.
if (unfencedLongest.lines >= THRESHOLDS.longestVerbatimBlockMax) reasons.push(`UNFENCED verbatim block of ${unfencedLongest.lines} lines (>= ${THRESHOLDS.longestVerbatimBlockMax}) from ${unfencedLongest.sourceFile}`);
if (unfencedVerbatimLines >= THRESHOLDS.totalVerbatimLinesMax) reasons.push(`${unfencedVerbatimLines} UNFENCED lines copied verbatim from source (>= ${THRESHOLDS.totalVerbatimLinesMax})`);
const flagged = reasons.length > 0;

writeFileSync(outPath, JSON.stringify({
  section: 'code-copy',
  thresholds: THRESHOLDS,
  totalNonBlankLines: totalNonBlank,
  fencedCodeLines: fencedLines.length,
  fenceRatio: Number(fenceRatio.toFixed(3)),
  longestVerbatimBlock: longest,
  verbatimBlocksOverMin: blocksOverMin,
  totalVerbatimLines,
  unfencedLongestVerbatimBlock: unfencedLongest,
  unfencedVerbatimLines,
  flagged,
  verdict: flagged ? 'source-dump-flagged' : 'essence',
  reasons,
}, null, 2) + '\n');
console.log(`[code-copy] verdict: ${flagged ? 'SOURCE-DUMP FLAGGED' : 'essence'} (fence ${(fenceRatio * 100).toFixed(0)}%, longest fenced block ${longest.lines}, ${totalVerbatimLines} fenced verbatim; unfenced longest ${unfencedLongest.lines}, ${unfencedVerbatimLines} unfenced verbatim)`);
for (const r of reasons) console.log(`  - ${r}`);
