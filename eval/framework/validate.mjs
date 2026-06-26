#!/usr/bin/env node
// Dependency-free JSON-Schema validator (the eval framework forbids third-party
// deps; pure Node, runs on node:20). Supports the SUBSET of draft-07 used by the
// framework schemas: type, required, properties, additionalProperties:false,
// enum, pattern, items, minimum, and (for arrays/objects) nested schemas.
//
// It is deliberately small and strict: an unsupported keyword is ignored, but the
// keywords above are enforced exactly, which is enough to validate eval.json and
// criteria.json against framework/schemas/*.
//
// Usage:
//   validate.mjs <schema.json> <instance.json> [--assert-count <countField>:<arrayField>]
//     exit 0 = valid; 1 = invalid (errors printed); 2 = bad args / unreadable.
//   --assert-count count:criteria  also asserts instance.count === instance.criteria.length
//     (the criteria.json "records its own expected count" rule).
//
// Importable: validateAgainst(schema, data) -> string[] of error messages ([] = valid).

import { readFileSync } from 'node:fs';

const TYPE_OF = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // 'number' | 'string' | 'boolean' | 'object'
};

// 'integer' satisfies 'number'; everything else must match exactly.
function typeMatches(expected, actual) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return expected === actual;
}

export function validateAgainst(schema, data, path = '$', errors = []) {
  if (schema == null || typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const actual = TYPE_OF(data);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${allowed.join('|')}, got ${actual}`);
      return errors; // type wrong → downstream checks are noise
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => e === data)) {
    errors.push(`${path}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof data === 'string' && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern).test(data)) {
      errors.push(`${path}: "${data}" does not match pattern /${schema.pattern}/`);
    }
  }

  if (typeof data === 'number' && schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
  }

  if (TYPE_OF(data) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in data)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) validateAgainst(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${k}" (additionalProperties:false)`);
      }
    }
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => validateAgainst(schema.items, item, `${path}[${i}]`, errors));
  }

  return errors;
}

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`validate: cannot read/parse ${p}: ${e.message}`);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const [schemaPath, instancePath] = positional;
  if (!schemaPath || !instancePath) {
    console.error('usage: validate.mjs <schema.json> <instance.json> [--assert-count <countField>:<arrayField>]');
    process.exit(2);
  }
  const schema = readJSON(schemaPath);
  const data = readJSON(instancePath);

  const errors = validateAgainst(schema, data);

  const ai = args.indexOf('--assert-count');
  if (ai !== -1) {
    const spec = args[ai + 1] || '';
    const [countField, arrayField] = spec.split(':');
    if (!countField || !arrayField) {
      console.error('validate: --assert-count needs <countField>:<arrayField>');
      process.exit(2);
    }
    const declared = data[countField];
    const actual = Array.isArray(data[arrayField]) ? data[arrayField].length : undefined;
    if (declared !== actual) {
      errors.push(`$: self-declared ${countField}=${JSON.stringify(declared)} != ${arrayField}.length=${JSON.stringify(actual)}`);
    }
  }

  if (errors.length) {
    console.error(`INVALID: ${instancePath} (vs ${schemaPath})`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: ${instancePath} validates against ${schemaPath}${ai !== -1 ? ' (+ count assertion)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
