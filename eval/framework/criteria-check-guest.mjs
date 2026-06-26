#!/usr/bin/env node
// our-criteria scorer — the macos-vm / GUEST lane (Chunk 5, §6 dimension 1).
//
// The macos analog of criteria-check.mjs (the docker lane). Same `check` semantics —
// exit code + stdout/stderr assertions — but the built CLI runs IN THE GUEST over SSH
// (`guest-cli` check type) instead of via `docker run`. The host never runs the artifact;
// it drives the guest (the `ssh-to-guest` envHandle).
//
// Usage:
//   criteria-check-guest.mjs <guestIp> <guestWs> <criteriaPath> <outPath>
//     [--user <u>] [--key <path>]
//   each `guest-cli` check: { bin, argv[], expectExit?, expectExitNonZero?,
//     stdoutContains[]?, stderrContains[]?, stdoutNonEmpty?, minLines?, stdoutMatches? }
// Writes <outPath> (criteria-results JSON, same shape as criteria-check.mjs). Exit 0 always
// (a failing criterion is data); exit 2 on bad args.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
function opt(f, d) { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; }
const [guestIp, guestWs, criteriaPath, outPath] = pos;
const user = opt('--user', process.env.NEO_GUEST_USER || 'admin');
const key = opt('--key', process.env.NEO_GUEST_KEY || `${process.env.HOME}/.ssh/neo_guest_ed25519`);
if (!guestIp || !guestWs || !criteriaPath || !outPath) {
  console.error('usage: criteria-check-guest.mjs <guestIp> <guestWs> <criteriaPath> <outPath> [--user u] [--key path]');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(criteriaPath, 'utf8'));

// shell-quote a single argument for the remote shell.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function runGuestCli(bin, args) {
  // cd into the guest workspace, run the built binary with argv, capture exit+stdout+stderr.
  const remote = `cd ${q(guestWs)} && ${q('./' + bin.replace(/^\.\//, ''))} ${(args || []).map(q).join(' ')}`;
  try {
    const stdout = execFileSync('ssh', [
      '-i', key, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${guestIp}`, remote,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, stdout, stderr: '' };
  } catch (e) {
    return { exit: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function evalGuestCli(check) {
  const r = runGuestCli(check.bin, check.argv || []);
  const reasons = [];
  const nonEmptyLines = r.stdout.split('\n').filter((l) => l.trim().length).length;
  if (check.expectExit !== undefined && r.exit !== check.expectExit) reasons.push(`exit ${r.exit} != expected ${check.expectExit}`);
  if (check.expectExitNonZero && r.exit === 0) reasons.push('expected non-zero exit, got 0');
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
  if (c.check.type === 'guest-cli') outcome = evalGuestCli(c.check);
  else outcome = { pass: false, reasons: [`unsupported check type "${c.check.type}" (macos lane expects "guest-cli")`], observed: {} };
  results.push({ id: c.id, tier: c.tier, category: c.category, description: c.description, check: c.check, ...outcome });
  console.log(`[criteria] ${outcome.pass ? 'PASS' : 'FAIL'} [${c.tier}] ${c.id}${outcome.pass ? '' : ' — ' + outcome.reasons.join('; ')}`);
}

const N = results.length;
const passed = results.filter((r) => r.pass).length;
const gateResults = results.filter((r) => r.tier === 'gate');
const gateFailed = gateResults.filter((r) => !r.pass).map((r) => r.id);
const gradedResults = results.filter((r) => r.tier === 'graded');

const out = {
  section: 'our-criteria',
  lane: 'macos-vm',
  criteriaFile: criteriaPath,
  N,
  passed,
  score: N ? passed / N : null,
  hardGateFailed: gateFailed.length > 0,
  gates: { total: gateResults.length, passed: gateResults.filter((r) => r.pass).length, failed: gateFailed },
  graded: { total: gradedResults.length, passed: gradedResults.filter((r) => r.pass).length },
  results,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`[criteria] our-criteria: ${passed}/${N} (gates ${out.gates.passed}/${out.gates.total}${out.hardGateFailed ? ' — HARD GATE FAILED' : ''})`);
