#!/usr/bin/env node
// Reference-evidence capture (Setup stage, §4 — "capture reference evidence into
// oracle/reference/"). For a docker/CLI target, runs the BUILT original's CLI with
// each manifest-declared invocation and saves stdout+stderr as the reference the
// Evaluator's visual/terminal scorer (Chunk 2) compares the install against.
//
// Pure Node; shells out to `docker run` via execFileSync (argv array — no quoting
// hazards even when an argument contains spaces, e.g. "OH MY LOGO").
//
// Usage: capture-reference.mjs <sourceDir> <refDir> <image> <bin> <capturesJson> <sha>
// Writes <refDir>/<id>.txt per capture + <refDir>/index.json (the reference manifest).
// Exit: 0 ok; 2 bad args.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [sourceDir, refDir, image, bin, capturesJson, sha] = process.argv.slice(2);
if (!sourceDir || !refDir || !image || !bin || !capturesJson) {
  console.error('usage: capture-reference.mjs <sourceDir> <refDir> <image> <bin> <capturesJson> <sha>');
  process.exit(2);
}
const captures = JSON.parse(capturesJson);

rmSync(refDir, { recursive: true, force: true });
mkdirSync(refDir, { recursive: true });

const index = { schemaVersion: 1, sha: sha || null, image, bin, captures: [] };
for (const cap of captures) {
  const file = `${cap.id}.txt`;
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync(
      'docker',
      ['run', '--rm', '--network', 'bridge', '-v', `${sourceDir}:/work`, '-w', '/work', image, 'node', bin, ...cap.argv],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    // A non-zero exit still produced reference output (e.g. a usage banner) — keep it.
    out = (e.stdout || '') + (e.stderr || '');
    exitCode = typeof e.status === 'number' ? e.status : 1;
  }
  writeFileSync(join(refDir, file), out);
  index.captures.push({ id: cap.id, argv: cap.argv, file, exitCode, bytes: Buffer.byteLength(out) });
  console.log(`[reference] ${cap.id}: ${Buffer.byteLength(out)} bytes (exit ${exitCode}) -> ${file}`);
}
writeFileSync(join(refDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`[reference] wrote ${index.captures.length} capture(s) + index.json to ${refDir}`);
