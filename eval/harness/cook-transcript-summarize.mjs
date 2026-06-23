#!/usr/bin/env node
// Summarize the cook's stream-json transcript (Chunk 3) into a readable transcript
// + a tool log (every shell/tool call, to audit blindness). Best-effort parser.
//
// Usage: cook-transcript-summarize.mjs <transcript.jsonl> <runDir>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [jsonl, runDir] = process.argv.slice(2);
if (!jsonl || !runDir) { console.error('usage: cook-transcript-summarize.mjs <jsonl> <runDir>'); process.exit(1); }

const lines = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
const readable = [];
const toolLog = [];
let toolN = 0;

for (const ln of lines) {
  let e;
  try { e = JSON.parse(ln); } catch { continue; }
  const msg = e.message || e;
  const content = msg?.content;
  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) readable.push(`### assistant\n${c.text.trim()}`);
      if (c.type === 'tool_use') {
        toolN++;
        const inp = c.name === 'Bash' ? (c.input?.command ?? '') : JSON.stringify(c.input);
        toolLog.push(`#${toolN} [${c.name}] ${typeof inp === 'string' ? inp : ''}`);
        readable.push(`### tool_use: ${c.name}\n\`\`\`\n${typeof inp === 'string' ? inp : JSON.stringify(c.input, null, 2)}\n\`\`\``);
      }
    }
  }
  if (e.type === 'user' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'tool_result') {
        const out = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : (c.content ?? '');
        const trimmed = String(out).slice(0, 1500);
        readable.push(`### tool_result${c.is_error ? ' (ERROR)' : ''}\n\`\`\`\n${trimmed}\n\`\`\``);
      }
    }
  }
  if (e.type === 'result') {
    readable.push(`### RESULT (${e.subtype || ''})\n${e.result || ''}`);
  }
}

writeFileSync(join(runDir, 'cook-readable.md'), `# Cook transcript (readable)\n\n${readable.join('\n\n')}\n`);
writeFileSync(join(runDir, 'cook-tool-log.txt'), toolLog.join('\n') + '\n');
console.log(`[cook] transcript: ${toolN} tool call(s); wrote cook-readable.md + cook-tool-log.txt`);
