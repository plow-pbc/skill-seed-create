#!/usr/bin/env node
// PreToolUse confinement gate for the macos-vm cooks (Chunk 5) — the macos analog of
// harness/cook-tool-guard.mjs (the docker guard). Same deny-by-default posture and the
// SAME filesystem-axis confinement (file tools → one workspace), but the network/build
// axis differs:
//
//   docker guard:  Bash → exactly one `docker exec <container>` (build co-located).
//   macos guard:   Bash → exactly one invocation of the pinned GUEST-BUILD SEAM
//                  (env COOK_GUEST_SEAM): a wrapper that rsyncs the host workspace into
//                  the guest, runs the script IN THE GUEST over SSH, and pulls artifacts
//                  back. The cook therefore has NO host shell — every command it runs
//                  executes in the guest (the `ssh-to-guest` envHandle).
//
//   If COOK_GUEST_SEAM is empty/unset, Bash is DENIED entirely (used for the Seed Creator,
//   which is file-tools-only on the host so it can never host-shell-read the oracle).
//
// FILESYSTEM axis: every file tool is confined to COOK_WORKSPACE (abs/.. /symlink safe);
// COOK_ALLOW_READ (':'-sep) grants extra read-only roots (the seed-create skill docs).
// Network-capable tools (WebFetch/WebSearch/Agent/Task/AskUserQuestion) are denied.
//
// Input: PreToolUse event JSON on stdin. Output: a permissionDecision object.

import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, join, sep, isAbsolute } from 'node:path';

const WORKSPACE_ENV = process.env.COOK_WORKSPACE || '';
const SEAM = process.env.COOK_GUEST_SEAM || '';

let evt = {};
try { evt = JSON.parse(readFileSync(0, 'utf8')); } catch { /* malformed -> deny below */ }
const tool = evt.tool_name || '';
const input = evt.tool_input || {};
const cwd = evt.cwd || process.cwd();

function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// ---- workspace containment (abs / .. / symlink safe) — mirrors cook-tool-guard.mjs ----
function realResolve(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let real;
  try { real = realpathSync(cur); } catch { real = cur; }
  return tail.length ? join(real, ...tail) : real;
}
function realRoot(r) { try { return realpathSync(r); } catch { return resolve(r); } }
let WS = '';
if (WORKSPACE_ENV) WS = realRoot(WORKSPACE_ENV);
const READ_ROOTS = (process.env.COOK_ALLOW_READ || '').split(':').filter(Boolean).map(realRoot);
function under(rp, root) { return root && (rp === root || rp.startsWith(root + sep)); }
function within(p, readOnly) {
  if (!WS) return false;
  const base = isAbsolute(p) ? p : join(cwd, p);
  const rp = realResolve(base);
  if (under(rp, WS)) return true;
  if (readOnly) for (const r of READ_ROOTS) if (under(rp, r)) return true;
  return false;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
function globPrefix(s) { const i = String(s).search(/[*?\[{]/); return i === -1 ? String(s) : String(s).slice(0, i); }
function expandBraces(p) {
  const i = p.indexOf('{');
  if (i === -1) return [p];
  let d = 0, j = i;
  for (; j < p.length; j++) { if (p[j] === '{') d++; else if (p[j] === '}' && --d === 0) break; }
  if (j >= p.length) return [p];
  const pre = p.slice(0, i), post = p.slice(j + 1), opts = p.slice(i + 1, j).split(',');
  return opts.flatMap((o) => expandBraces(pre + o + post));
}
function patternEscapes(param, base, readOnly) {
  for (let cand of expandBraces(String(param))) {
    if (/\[[^\]]*[.\/][^\]]*\]/.test(cand)) return true;
    cand = cand.replace(/\[([^\]])\]/g, '$1');
    if (/(^|\/)\.\.(\/|$)/.test(cand)) return true;
    const pref = globPrefix(cand);
    const abs = isAbsolute(pref) ? pref : join(base, pref);
    if (!within(abs, readOnly)) return true;
  }
  return false;
}
function directPaths(t, inp) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.length) out.push(v); };
  if (t === 'Read' || t === 'Edit' || t === 'Write') push(inp.file_path);
  else if (t === 'NotebookEdit') push(inp.notebook_path);
  else if (t === 'LS') push(inp.path);
  else if (t === 'Glob' || t === 'Grep') push(inp.path);
  return out;
}
if (FILE_TOOLS.has(tool)) {
  const readOnly = (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'LS');
  const escapes = directPaths(tool, input).filter((p) => !within(p, readOnly));
  if (tool === 'Glob' || tool === 'Grep') {
    const rawBase = (typeof input.path === 'string' && input.path) ? input.path : cwd;
    const base = isAbsolute(rawBase) ? rawBase : join(cwd, rawBase);
    const pats = [];
    if (tool === 'Glob' && typeof input.pattern === 'string') pats.push(input.pattern);
    if (tool === 'Grep' && typeof input.glob === 'string') pats.push(input.glob);
    if (tool === 'Grep' && typeof input.include === 'string') pats.push(input.include);
    for (const p of pats) if (patternEscapes(p, base, readOnly)) escapes.push(p);
  }
  if (escapes.length) {
    decide('deny', `CONFINEMENT (filesystem): ${tool} target escapes the workspace: ${escapes.map((p) => `"${p}"`).join(', ')}. ` +
      `The cook may only touch the workspace at ${WS || '(unset)'} (plus allowed read-only skill docs).`);
  }
  decide('allow', `confined: ${tool} stays inside the workspace${readOnly && READ_ROOTS.length ? ' / allowed skill docs' : ''}`);
}

const NET_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion']);
if (NET_TOOLS.has(tool)) decide('deny', `CONFINEMENT: ${tool} is not permitted in an eval cook.`);

// ---- Bash: confine to ONE invocation of the pinned guest-build seam ----------
function hostMetaViolation(s) {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === '"') inD = false; else if (c === '$' || c === '`') return c; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '\n' || c === '\r') return '\\n';
    if (';|&<>()`$'.includes(c)) return c;
    if (c === '\\') return '\\';
  }
  return (inS || inD) ? 'unterminated-quote' : null;
}
if (tool === 'Bash') {
  const cmd = String(input.command ?? '');
  if (!SEAM) {
    decide('deny', 'CONFINEMENT: Bash is disabled for this cook (file-tools only). Study and write files with Read/Glob/Grep/Write/Edit. ' +
      'There is no host shell — by design, so the cook cannot read anything outside its workspace.');
  }
  const meta = hostMetaViolation(cmd);
  if (meta) {
    decide('deny', `CONFINEMENT (build): host-level shell metacharacter "${meta}" is not permitted. ` +
      `Run EXACTLY one  bash ${SEAM} '<script>'  — put all chaining/pipes/redirects INSIDE the single-quoted script (it runs in the GUEST).`);
  }
  // Block anything that could reconfigure/escape the guest plumbing.
  if (/(\bssh\b|\brsync\b|\btart\b|\bneo-vm\b|\bscp\b)/i.test(cmd)) {
    decide('deny', 'CONFINEMENT (build): direct ssh/rsync/tart/scp is not permitted — use the guest-build seam.');
  }
  // Allow ONLY `bash <SEAM> ...` or `<SEAM> ...` (the pinned wrapper, absolute path).
  const seamRe = new RegExp('^\\s*(?:bash\\s+)?' + SEAM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
  if (seamRe.test(cmd)) decide('allow', `confined: single guest-build seam (${SEAM})`);
  decide('deny', `CONFINEMENT (build): the cook's shell is the guest-build seam ONLY. Run shell as:  bash ${SEAM} '<script>'  ` +
    `(the script executes in the guest; artifacts sync back automatically). Do not fetch the target.`);
}

const PASSTHRU = new Set(['Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'ToolSearch']);
if (tool && PASSTHRU.has(tool)) decide('allow', `safe orchestration tool: ${tool}`);
decide('deny', `CONFINEMENT: tool "${tool || '(none)'}" is not on the allow-list (deny-by-default).`);
