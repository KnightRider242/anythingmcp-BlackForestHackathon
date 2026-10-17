// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deterministic processor chains for connector responses. Operators are data,
 * never evaluated JavaScript. A chain is opt-in per tool responseMapping.
 * It runs before the existing response mapping and never mutates upstream data.
 */
type Row = Record<string, unknown>;
type Mode = 'add' | 'replace';

type Multiply = {
  operation: 'multiply';
  input: string;
  output: string;
  factor: number;
  decimals: number;
  mode: Mode;
};
type NormalizeWhitespace = {
  operation: 'normalizeWhitespace';
  input: string;
  output: string;
  mode: Mode;
};
type Step = Multiply | NormalizeWhitespace;
type Chain = { itemsField: string; steps: Step[] };

const MAX_STEPS = 8;
const MAX_ITEMS = 10_000;
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FORBIDDEN_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function record(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_FIELD.test(value) || FORBIDDEN_FIELDS.has(value)) {
    throw new Error(`${label} must be a safe field name`);
  }
  return value;
}

function keys(value: Row, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unsupported property "${key}"`);
  }
}

function parseChain(input: unknown): Chain {
  if (!record(input)) throw new Error('processorChain must be an object');
  keys(input, ['itemsField', 'steps'], 'processorChain');
  const itemsField = field(input.itemsField, 'itemsField');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
    throw new Error(`processorChain.steps must contain 1-${MAX_STEPS} steps`);
  }
  const steps = input.steps.map((raw, i): Step => {
    const label = `steps[${i}]`;
    if (!record(raw)) throw new Error(`${label} must be an object`);
    const operation = raw.operation;
    if (operation !== 'multiply' && operation !== 'normalizeWhitespace') {
      throw new Error(`${label}.operation must be multiply or normalizeWhitespace`);
    }
    keys(raw, operation === 'multiply'
      ? ['operation', 'input', 'output', 'factor', 'decimals', 'mode']
      : ['operation', 'input', 'output', 'mode'], label);
    const input = field(raw.input, `${label}.input`);
    const output = field(raw.output, `${label}.output`);
    if (raw.mode !== 'add' && raw.mode !== 'replace') {
      throw new Error(`${label}.mode must be add or replace`);
    }
    const mode = raw.mode as Mode;
    if (operation === 'normalizeWhitespace') return { operation, input, output, mode };
    if (typeof raw.factor !== 'number' || !Number.isFinite(raw.factor) ||
      raw.factor < 0 || raw.factor > 1000) throw new Error(`${label}.factor must be a finite number between 0 and 1000`);
    if (typeof raw.decimals !== 'number' || !Number.isInteger(raw.decimals) ||
      raw.decimals < 0 || raw.decimals > 6) throw new Error(`${label}.decimals must be an integer between 0 and 6`);
    return { operation, input, output, factor: raw.factor, decimals: raw.decimals, mode };
  });
  return { itemsField, steps };
}

/** Null means valid; malformed configured chains are rejected, not ignored. */
export function validateProcessorChain(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  try {
    parseChain(input);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid processor chain';
  }
}

export function applyProcessorChain(
  raw: unknown,
  responseMapping: Record<string, unknown> | null | undefined,
): unknown {
  if (!responseMapping || responseMapping.processorChain === undefined ||
    responseMapping.processorChain === null) return raw;
  const chain = parseChain(responseMapping.processorChain);
  const arrayRoot = Array.isArray(raw);
  if (!arrayRoot && !record(raw)) throw new Error('Processor input must be an object or array');
  const items = arrayRoot ? raw : (raw as Row)[chain.itemsField];
  if (!Array.isArray(items)) throw new Error(`${chain.itemsField} must be an array`);
  if (items.length > MAX_ITEMS) throw new Error(`${chain.itemsField} exceeds ${MAX_ITEMS} items`);

  // Work on fresh objects and publish the transformed document only once ALL
  // rows and steps succeed. No partial result, fallback, or mutation on error.
  const transformed = items.map((item: unknown, index: number) => {
    if (!record(item)) throw new Error(`${chain.itemsField}[${index}] must be an object`);
    const row: Row = { ...item };
    for (const step of chain.steps) {
      const at = `${chain.itemsField}[${index}].${step.input}`;
      if (!Object.prototype.hasOwnProperty.call(row, step.input)) {
        throw new Error(`${at} is missing`);
      }
      const exists = Object.prototype.hasOwnProperty.call(row, step.output);
      if (step.mode === 'add' && exists) throw new Error(`${step.output} already exists`);
      if (step.mode === 'replace' && !exists) throw new Error(`${step.output} is missing`);
      const value = row[step.input];
      if (step.operation === 'multiply') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`${at} must be a finite number`);
        }
        const scaled = value * step.factor;
        if (!Number.isFinite(scaled)) throw new Error(`${at} overflows`);
        const scale = 10 ** step.decimals;
        row[step.output] = Math.round(scaled * scale) / scale;
      } else {
        if (typeof value !== 'string') throw new Error(`${at} must be a string`);
        row[step.output] = value.trim().replace(/\s+/g, ' ');
      }
    }
    return row;
  });
  return arrayRoot ? transformed : { ...(raw as Row), [chain.itemsField]: transformed };
}
