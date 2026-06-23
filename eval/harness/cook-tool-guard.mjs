#!/usr/bin/env node
// PreToolUse blindness gate for the author-creator cook (Chunk 3).
//
// THE FIX (review cycle 2): the previous guard intercepted ONLY `Bash`, so the
// cook could `Read`/`Glob`/`Grep` an oracle file directly (e.g. an unstripped
// clone, or the oracle manifest config.json). This guard enforces TWO of the
// three blindness axes at the tool boundary, deny-by-default:
//
//   FILESYSTEM axis: every file tool (Read/Glob/Grep/LS/Edit/Write/NotebookEdit)
//     is confined to a SINGLE stripped workspace (env COOK_WORKSPACE). Any path
//     that RESOLVES outside it is denied. Resolution defeats absolute paths, `..`
//     traversal, and symlink escapes (we realpath the nearest existing ancestor,
//     which collapses `..` lexically and resolves any symlinked component).
//
//   NETWORK axis: `Bash` is confined to `docker exec <NAME>` into the net-off
//     capture container (env COOK_CAPTURE_CONTAINER); container-escape / network
//     -reconfig verbs are blocked. The cook therefore has NO host-shell and NO
//     net path; the container's --network none is proven separately (egress log).
//
// Network-capable tools (WebFetch/WebSearch/Agent/Task/AskUserQuestion) are denied
// here too (defense in depth; they are also withheld at launch). Skill/TodoWrite
// and other non-file tools pass through.
//
// The cook is launched with cwd = COOK_WORKSPACE, so default cwd-relative file
// paths land inside the workspace and resolve as allowed; only escapes are denied.
//
// Input: PreToolUse event JSON on stdin.
// Output: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }

import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, join, sep, isAbsolute } from 'node:path';

const WORKSPACE_ENV = process.env.COOK_WORKSPACE || '';
const NAME = process.env.COOK_CAPTURE_CONTAINER || '';

let evt = {};
try { evt = JSON.parse(readFileSync(0, 'utf8')); } catch { /* empty / malformed -> deny below */ }

const tool = evt.tool_name || '';
const input = evt.tool_input || {};
// cwd of the cook process for the call (PreToolUse carries it); base for relative paths.
const cwd = evt.cwd || process.cwd();

function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// ---- workspace containment (abs / .. / symlink safe) -----------------------
// Resolve a path to its real location by realpath'ing the nearest EXISTING
// ancestor (which resolves symlinked components and is immune to `..`), then
// re-appending the non-existent tail (which cannot itself be a symlink).
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
// COOK_ALLOW_READ: ':'-separated extra roots the cook may READ but not write — used
// ONLY to grant the seed-create skill's own (target-agnostic, oracle-free) reference
// files (SKILL.md/SEED.md/README.md). It does NOT relax write tools and does NOT
// include the target repo, the oracle manifest (config.json), or the spec/briefs.
const READ_ROOTS = (process.env.COOK_ALLOW_READ || '').split(':').filter(Boolean).map(realRoot);

function under(rp, root) { return root && (rp === root || rp.startsWith(root + sep)); }
// readOnly=true => workspace OR an allow-read root; writes => workspace only.
function within(p, readOnly) {
  if (!WS) return false; // no workspace configured -> nothing is inside it
  const base = isAbsolute(p) ? p : join(cwd, p);
  const rp = realResolve(base);
  if (under(rp, WS)) return true;
  if (readOnly) for (const r of READ_ROOTS) if (under(rp, r)) return true;
  return false;
}

// ---- file tools: confine to the single stripped workspace ------------------
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LS']);

// The non-glob literal prefix of a pattern (everything before the first magic char).
// `../**/*.test.ts` -> `../`, `node_modules/**` -> `node_modules/`, `**/x` -> ``.
function globPrefix(s) {
  const i = String(s).search(/[*?\[{]/);
  return i === -1 ? String(s) : String(s).slice(0, i);
}

// Return EVERY path the call could read/write, as strings to feed to within().
// Critical: for Glob/Grep we must resolve EVERY path-bearing param — `path`,
// Glob's `pattern`, and Grep's `glob` — relative to the effective base (path||cwd),
// so a relative `../` escape in the pattern/glob is caught (prior bypass).
function filePaths(t, inp) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.length) out.push(v); };
  if (t === 'Read' || t === 'Edit' || t === 'Write') push(inp.file_path);
  else if (t === 'NotebookEdit') push(inp.notebook_path);
  else if (t === 'LS') push(inp.path);
  else if (t === 'Glob' || t === 'Grep') {
    // effective base for relative patterns: inp.path if given, else cwd
    const rawBase = (typeof inp.path === 'string' && inp.path) ? inp.path : cwd;
    const base = isAbsolute(rawBase) ? rawBase : join(cwd, rawBase);
    push(inp.path);                                   // the search root itself
    const pats = [];
    if (t === 'Glob' && typeof inp.pattern === 'string') pats.push(inp.pattern);
    if (t === 'Grep' && typeof inp.glob === 'string') pats.push(inp.glob); // Grep's path filter
    for (const p of pats) {
      const pref = globPrefix(p);
      out.push(isAbsolute(pref) ? pref : join(base, pref));
    }
    if (out.length === 0) out.push(cwd);              // no params => searches cwd
  }
  return out;
}

if (FILE_TOOLS.has(tool)) {
  const readOnly = (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'LS');
  const paths = filePaths(tool, input);
  const escapes = paths.filter((p) => !within(p, readOnly));
  if (escapes.length) {
    decide('deny',
      `BLINDNESS GATE (filesystem): ${tool} target escapes the stripped workspace: ` +
        `${escapes.map((p) => `"${p}"`).join(', ')}. The author-creator may only read the single ` +
        `oracle-stripped workspace at ${WS || '(unset)'} (plus the seed-create skill's own docs). ` +
        `The held-out test suite, runner config, lockfile, and the oracle manifest are NOT readable.`);
  }
  decide('allow', `confined: ${tool} stays inside the stripped workspace${readOnly && READ_ROOTS.length ? ' / allowed skill docs' : ''}`);
}

// ---- network-capable tools: deny (defense in depth) ------------------------
const NET_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion']);
if (NET_TOOLS.has(tool)) {
  decide('deny', `BLINDNESS GATE: ${tool} is not permitted — the cook is test-blind and offline.`);
}

// ---- Bash: confine to ONE docker-exec-into-net-off-container invocation ------
// Prior CRITICAL bypass: the allow-rule was prefix-only, so anything after a
// well-formed `docker exec NAME ...` ran on the HOST —
//   docker exec NAME sh -lc 'true'; curl ...        (host chain)
//   docker exec -i NAME sh -lc cat < hostfile        (host redirect / exfil)
// Fix: reject ANY host-level shell metacharacter that chains/backgrounds/redirects/
// substitutes, OUTSIDE single quotes. Inside single quotes (the `sh -lc '…'` arg)
// the cook may freely use |, <, ;, $ — that all runs INSIDE the container.
// `$` and backtick are also flagged inside DOUBLE quotes (command substitution
// still expands on the host there); only single quotes fully neutralise them.
function hostMetaViolation(s) {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) {
      if (c === '"') inD = false;
      else if (c === '$' || c === '`') return c;     // host command/var substitution in dquotes
      continue;
    }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '\n' || c === '\r') return '\\n';
    if (';|&<>()`$'.includes(c)) return c;           // chain/bg/pipe/redirect/subshell/subst
    if (c === '\\') return '\\';                      // host-level escape
  }
  return (inS || inD) ? 'unterminated-quote' : null;
}

if (tool === 'Bash') {
  const cmd = String(input.command ?? '');

  const meta = hostMetaViolation(cmd);
  if (meta) {
    decide('deny',
      `BLINDNESS GATE (network): host-level shell metacharacter "${meta}" is not permitted. ` +
        `Run EXACTLY one  docker exec ${NAME} sh -lc '<script>'  — put all chaining/pipes/redirects ` +
        `INSIDE the single-quoted script (it executes in the offline container, not on the host).`);
  }

  // Hard blocks: anything that could escape the net-off container or open a net path.
  const ESCAPE = /(docker\s+(run|create|network|cp|build)|--network|--privileged|--cap-add|nsenter|\bunshare\b|\bip\s+netns\b|\/proc\/1\/root)/i;
  if (ESCAPE.test(cmd)) {
    decide('deny', 'BLINDNESS GATE (network): container-escape / network-reconfig verb is not permitted.');
  }

  // Allow ONLY `docker exec [flags] <NAME> …` into the run's designated net-off
  // container (NAME is pinned exactly; a different/long-prefixed container fails).
  const flag = '(?:-[itu]+|--interactive|--tty|-e\\s+\\S+|--env\\s+\\S+|-w\\s+\\S+|--workdir(?:=|\\s+)\\S+|-u\\s+\\S+)';
  const allowed = NAME && new RegExp(
    '^\\s*docker\\s+exec\\s+(?:' + flag + '\\s+)*' +
      NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)'
  );
  if (allowed && allowed.test(cmd)) {
    decide('allow', `confined: single docker exec into net-off container ${NAME}`);
  }

  decide('deny',
    `BLINDNESS GATE (network): the cook's shell is confined to the OFFLINE container "${NAME}". ` +
      `Run shell ONLY as:  docker exec ${NAME} sh -lc '<command>'  (it has NO network; do not and ` +
      `cannot fetch the target). Study files with Read/Glob/Grep inside the stripped workspace.`);
}

// ---- deny-by-default: only an explicit allow-list of safe, non-file/non-network
// orchestration tools passes. Unknown / aliased / case-variant tools (e.g.
// lowercase `read`, `MultiEdit`) are DENIED (prior bug: they were allowed). ------
const PASSTHRU = new Set([
  'Skill', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop',
  'ToolSearch',
]);
if (tool && PASSTHRU.has(tool)) {
  decide('allow', `safe orchestration tool (no filesystem/network reach): ${tool}`);
}
decide('deny',
  `BLINDNESS GATE: tool "${tool || '(none)'}" is not on the allow-list (deny-by-default). ` +
    `Allowed: file tools (workspace-confined), Bash (docker-exec-only), Skill/TodoWrite/Task*/ToolSearch.`);
