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

let WS = '';
if (WORKSPACE_ENV) { try { WS = realpathSync(WORKSPACE_ENV); } catch { WS = resolve(WORKSPACE_ENV); } }

function within(p) {
  if (!WS) return false; // no workspace configured -> nothing is inside it
  const base = isAbsolute(p) ? p : join(cwd, p);
  const rp = realResolve(base);
  return rp === WS || rp.startsWith(WS + sep);
}

// ---- file tools: confine to the single stripped workspace ------------------
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
function filePaths(t, inp) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.length) out.push(v); };
  if (t === 'Read' || t === 'Edit' || t === 'Write') push(inp.file_path);
  else if (t === 'NotebookEdit') push(inp.notebook_path);
  else if (t === 'LS') push(inp.path);
  else if (t === 'Glob' || t === 'Grep') {
    push(inp.path);                                   // search root (defaults to cwd if absent)
    if (typeof inp.pattern === 'string' && isAbsolute(inp.pattern)) push(inp.pattern); // abs pattern escape
    if (out.length === 0) push(cwd);                  // no path => searches cwd; check cwd
  }
  return out;
}

if (FILE_TOOLS.has(tool)) {
  const paths = filePaths(tool, input);
  const escapes = paths.filter((p) => !within(p));
  if (escapes.length) {
    decide('deny',
      `BLINDNESS GATE (filesystem): ${tool} target escapes the stripped workspace: ` +
        `${escapes.map((p) => `"${p}"`).join(', ')}. The author-creator may only read the single ` +
        `oracle-stripped workspace at ${WS || '(unset)'}. The held-out test suite, runner config, ` +
        `lockfile, and the oracle manifest are NOT readable.`);
  }
  decide('allow', `confined: ${tool} stays inside the stripped workspace ${WS}`);
}

// ---- network-capable tools: deny (defense in depth) ------------------------
const NET_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion']);
if (NET_TOOLS.has(tool)) {
  decide('deny', `BLINDNESS GATE: ${tool} is not permitted — the cook is test-blind and offline.`);
}

// ---- Bash: confine to docker exec into the net-off capture container --------
if (tool === 'Bash') {
  const cmd = String(input.command ?? '');

  // Hard blocks: anything that could escape the net-off container or open a net path.
  const ESCAPE = /(docker\s+(run|create|network|cp|build)|--network|--privileged|--cap-add|nsenter|\bunshare\b|\bip\s+netns\b|\/proc\/1\/root)/i;
  if (ESCAPE.test(cmd)) {
    decide('deny', 'BLINDNESS GATE (network): container-escape / network-reconfig verb is not permitted.');
  }

  // Allow ONLY `docker exec [flags] <NAME> ...` into the designated net-off container.
  const flag = '(?:-[itu]+|--interactive|--tty|-e\\s+\\S+|--env\\s+\\S+|-w\\s+\\S+|--workdir(?:=|\\s+)\\S+|-u\\s+\\S+)';
  const allowed = NAME && new RegExp(
    '^\\s*docker\\s+exec\\s+(?:' + flag + '\\s+)*' +
      NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)'
  );
  if (allowed && allowed.test(cmd)) {
    decide('allow', `confined: runs inside net-off container ${NAME}`);
  }

  decide('deny',
    `BLINDNESS GATE (network): the cook's shell is confined to the OFFLINE container "${NAME}". ` +
      `Run shell ONLY as:  docker exec ${NAME} sh -lc '<command>'  (it has NO network; do not and ` +
      `cannot fetch the target). Study files with Read/Glob/Grep inside the stripped workspace.`);
}

// ---- everything else (Skill, TodoWrite, ...) -------------------------------
decide('allow', `non-file, non-network tool: ${tool || '(unknown)'}`);
