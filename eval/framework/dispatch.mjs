#!/usr/bin/env node
// The thin dispatcher (Chunk 1, §3 + §8 runner-selection seam).
//
// Reads evals/<target>/eval.json, validates it against framework/schemas/eval.schema.json,
// and resolves it into the config the stages consume:
//   { name, evalDir, environment, runner, source, build, testsCmd, oracle{criteria,reference}, setup }
// The single responsibility here is RESOLUTION + RUNNER SELECTION — it does not run
// any stage. Setup/Creator/Installer/Evaluator each consume this resolved config.
//
// Usage:
//   dispatch.mjs <target> [--json]     # print resolved config (default: human summary)
//   dispatch.mjs <target> --runner     # print just the selected runner id (docker|macos-vm)
// Exit: 0 ok; 1 invalid manifest / unknown target.
//
// Importable: resolveEval(target) -> resolved config (throws on invalid).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainst } from './validate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = __dirname;
const EVALS_DIR = resolve(__dirname, '..', 'evals');
const EVAL_SCHEMA = join(FRAMEWORK_DIR, 'schemas', 'eval.schema.json');

// The runner registry (§8). Both runners drive the same four stages; they differ in
// WHERE the agent runs vs where the build/oracle runs. docker is implemented in
// Chunk 1; macos-vm is declared here (the selection seam) and lands in Chunk 5.
export const RUNNERS = {
  docker: {
    id: 'docker',
    envHandle: 'docker exec', // how a stage reaches the build/oracle environment
    parallel: true,
    implemented: true,
    setup: 'setup.sh',
  },
  'macos-vm': {
    id: 'macos-vm',
    envHandle: 'ssh-to-guest',
    parallel: false, // ~1 VM on 8 GB — serial, materially slower (named, not hidden)
    implemented: true, // Chunk 5 — host (neo) drives a headless guest over SSH (setup-macos.sh / run-macos.sh)
    setup: 'setup-macos.sh',
  },
};

export class DispatchError extends Error {}

export function resolveEval(target) {
  const evalDir = join(EVALS_DIR, target);
  const manifestPath = join(evalDir, 'eval.json');
  if (!existsSync(manifestPath)) {
    throw new DispatchError(`no eval manifest at ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new DispatchError(`eval.json is not valid JSON: ${e.message}`);
  }

  const schema = JSON.parse(readFileSync(EVAL_SCHEMA, 'utf8'));
  const errs = validateAgainst(schema, manifest);
  if (errs.length) {
    throw new DispatchError(`eval.json invalid (vs eval.schema.json):\n  - ${errs.join('\n  - ')}`);
  }
  if (manifest.name !== target) {
    throw new DispatchError(`manifest name "${manifest.name}" != directory "${target}"`);
  }

  const runner = RUNNERS[manifest.environment.type];
  if (!runner) throw new DispatchError(`unknown environment.type "${manifest.environment.type}"`);

  // Resolve oracle paths to absolute (the Evaluator reads these; never materialized
  // into a Creator/Installer workspace).
  const oracle = {
    criteria: resolve(evalDir, manifest.oracle.criteria),
    reference: resolve(evalDir, manifest.oracle.reference),
  };

  return {
    name: manifest.name,
    evalDir,
    manifestPath,
    environment: manifest.environment,
    runner, // ← runner selection seam (§8)
    source: manifest.source || null,
    build: manifest.build || null,
    testsCmd: manifest.tests || null, // optional project tests
    scoring: manifest.scoring || null, // optional per-project composite-score recipe (§ scoring redirect)
    oracle,
    setup: {
      ...manifest.setup,
      testsLockedAbs: resolve(evalDir, manifest.setup.testsLocked),
    },
  };
}

function main() {
  const [target, flag] = process.argv.slice(2);
  if (!target) {
    console.error('usage: dispatch.mjs <target> [--json | --runner]');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = resolveEval(target);
  } catch (e) {
    console.error(`dispatch: ${e.message}`);
    process.exit(1);
  }

  if (flag === '--runner') {
    console.log(cfg.runner.id);
    return;
  }
  if (flag === '--json') {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  console.log(`target:       ${cfg.name}`);
  console.log(`environment:  ${cfg.environment.type} (image: ${cfg.environment.image})`);
  console.log(`runner:       ${cfg.runner.id}  [envHandle: ${cfg.runner.envHandle}, parallel: ${cfg.runner.parallel}, implemented: ${cfg.runner.implemented}]`);
  console.log(`source:       ${cfg.source ? `${cfg.source.repo} @ ${cfg.source.ref ?? cfg.source.sha}` : '(pre-populated source/)'}`);
  console.log(`build:        ${cfg.build ? `${cfg.build.install} && ${cfg.build.build}` : '(none)'}`);
  console.log(`tests-cmd:    ${cfg.testsCmd ?? '(none — project has no tests)'}`);
  console.log(`oracle:`);
  console.log(`  criteria:   ${cfg.oracle.criteria}`);
  console.log(`  reference:  ${cfg.oracle.reference}`);
  console.log(`setup:`);
  console.log(`  tests-locked:     ${cfg.setup.testsLockedAbs}`);
  console.log(`  reference caps:   ${cfg.setup.referenceCaptures.map((c) => c.id).join(', ')}`);
  console.log(`  expected tests:   ${cfg.setup.expectedTestCount ?? '(unspecified)'}`);
  if (!cfg.runner.implemented) {
    console.log(`\nNOTE: the ${cfg.runner.id} runner is declared but not yet implemented (Chunk 5).`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
