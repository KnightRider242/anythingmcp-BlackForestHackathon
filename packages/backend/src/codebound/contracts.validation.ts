// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { IsInt, IsString, Length, Max, Min, Validate, ValidatorConstraint } from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';
import { z } from 'zod';
import { MVP_LIMITS } from './contracts';
import type { JsonValue, ScriptExecutionRequest, ScriptSnapshot } from './contracts';

const id = z.string().min(1).max(128);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * Bound recursive work before serialization; reject getters/toJSON and cycles.
 * Transport readers must also cap raw bytes BEFORE JSON.parse. This function
 * cannot undo an unbounded HTTP body allocation.
 */
function isJson(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 50_000 || depth > 32) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > 50_000 - nodes) return false;
    if (array && keys.length !== item.length + 1) return false; // No holes/extra fields.
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  };
  return visit(value, 0);
}

function boundedJson(maxBytes: number) {
  return z.unknown().superRefine((value, context) => {
    if (!isJson(value)) {
      context.addIssue({ code: 'custom', message: 'Expected bounded, plain JSON' });
    } else if (bytes(JSON.stringify(value)) > maxBytes) {
      context.addIssue({ code: 'custom', message: 'JSON exceeds byte limit' });
    }
  }).transform((value) => JSON.parse(JSON.stringify(value)) as JsonValue);
}

function boundedObject(maxBytes: number) {
  return boundedJson(maxBytes).refine(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    { message: 'Expected JSON object' },
  ).transform((value) => value as { [key: string]: JsonValue });
}

export const scriptOutputSchema = boundedJson(MVP_LIMITS.maxOutputBytes);
const input = boundedObject(MVP_LIMITS.maxInputBytes);
const source = z.string().min(1).refine(
  (value) => bytes(value) <= MVP_LIMITS.maxSourceBytes,
  { message: 'Source exceeds byte limit' },
);

export const executionLimitsSchema = z.strictObject({
  wallTimeMs: z.number().int().positive().max(MVP_LIMITS.wallTimeMs),
  memoryBytes: z.number().int().positive().max(MVP_LIMITS.memoryBytes),
  cpuCores: z.number().positive().max(MVP_LIMITS.cpuCores),
  maxProcesses: z.number().int().positive().max(MVP_LIMITS.maxProcesses),
  maxSourceBytes: z.number().int().positive().max(MVP_LIMITS.maxSourceBytes),
  maxInputBytes: z.number().int().positive().max(MVP_LIMITS.maxInputBytes),
  maxOutputBytes: z.number().int().positive().max(MVP_LIMITS.maxOutputBytes),
  maxIpcFrameBytes: z.number().int().positive().max(MVP_LIMITS.maxIpcFrameBytes),
  maxConnectorCalls: z.literal(1),
  maxConnectorResponseBytes: z.number().int().positive().max(MVP_LIMITS.maxConnectorResponseBytes),
  maxLogBytes: z.number().int().nonnegative().max(MVP_LIMITS.maxLogBytes),
});

const errorCode = z.enum([
  'INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT', 'SCRIPT_ERROR',
  'CONNECTOR_ERROR', 'INVALID_OUTPUT', 'RESOURCE_LIMIT', 'CANCELLED',
  'SANDBOX_UNAVAILABLE', 'INTERNAL_ERROR',
]);
const resourceLimit = z.enum([
  'wallTime', 'memory', 'processes', 'sourceBytes', 'inputBytes', 'outputBytes',
  'ipcFrameBytes', 'connectorCalls', 'connectorResponseBytes', 'logBytes',
]);
export const codeboundErrorSchema = z.strictObject({
  code: errorCode,
  message: z.string().min(1).refine((value) => bytes(value) <= 512),
  limit: resourceLimit.optional(),
}).refine((value) => (value.code === 'RESOURCE_LIMIT') === (value.limit !== undefined), {
  message: 'Only resource-limit errors require a limit',
});

export const scriptExecutionRequestSchema = z.strictObject({
  scriptId: id,
  expectedRevision: revision,
  input,
});

@ValidatorConstraint({ name: 'codeboundJsonInput', async: false })
class JsonInputConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean { return input.safeParse(value).success; }
  defaultMessage(): string { return 'input must be a JSON object within MVP limits'; }
}

/** Future HTTP controllers must use whitelist + forbidNonWhitelisted. */
export class ScriptExecutionRequestDto implements ScriptExecutionRequest {
  @IsString()
  @Length(1, 128)
  scriptId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedRevision!: number;

  @Validate(JsonInputConstraint)
  input!: { [key: string]: JsonValue };
}

const binding = z.strictObject({ connectorId: id, toolId: id, definitionSha256: sha256 });
export const scriptDefinitionSchema = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  source,
  // JSON Schema document shape only; schema semantics are a later integration.
  inputSchema: boundedObject(16 * 1024),
  outputSchema: boundedObject(16 * 1024),
  binding,
});

export const scriptSnapshotSchema = scriptDefinitionSchema.extend({
  id,
  organizationId: id,
  ownerUserId: id,
  revision,
  sourceSha256: sha256,
}).refine((value) => value.sourceSha256 === createHash('sha256').update(value.source).digest('hex'), {
  message: 'Source hash does not match snapshot',
});

/** Detached and recursively frozen: caller mutation cannot change a run. */
export function parseScriptSnapshot(value: unknown): ScriptSnapshot {
  const snapshot = scriptSnapshotSchema.parse(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(snapshot);
  return snapshot;
}

export const sandboxExecutionRequestSchema = z.strictObject({
  executionId: id, source, input, limits: executionLimitsSchema,
}).superRefine((value, context) => {
  if (bytes(value.source) > value.limits.maxSourceBytes || bytes(JSON.stringify(value.input)) > value.limits.maxInputBytes) {
    context.addIssue({ code: 'custom', message: 'Request exceeds execution-specific limits' });
  }
});

export const sandboxConnectorCallSchema = z.strictObject({
  type: z.literal('connector.call'),
  requestId: id,
  binding: z.literal('connector.read'),
  arguments: input,
});

export const supervisorConnectorReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('connector.reply'), requestId: id, ok: z.literal(true),
    value: boundedJson(MVP_LIMITS.maxConnectorResponseBytes),
  }),
  z.strictObject({
    type: z.literal('connector.reply'), requestId: id, ok: z.literal(false),
    error: codeboundErrorSchema,
  }),
]);

/** Use on complete frames only; the reader must cap chunks before buffering. */
export function parseSandboxConnectorFrame(frame: string) {
  if (bytes(frame) > MVP_LIMITS.maxIpcFrameBytes) throw new Error('IPC frame exceeds byte limit');
  let value: unknown;
  try { value = JSON.parse(frame); } catch { throw new Error('Invalid IPC JSON'); }
  return sandboxConnectorCallSchema.parse(value);
}

const receipt = {
  executionId: id, scriptId: id, revision, sourceSha256: sha256,
  metrics: z.strictObject({
    wallTimeMs: z.number().finite().nonnegative(),
    connectorCalls: z.number().int().min(0).max(1),
    connectorResponseBytes: z.number().int().min(0).max(MVP_LIMITS.maxConnectorResponseBytes),
    outputBytes: z.number().int().min(0).max(MVP_LIMITS.maxOutputBytes),
  }),
};
export const scriptExecutionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...receipt, status: z.literal('succeeded'), output: scriptOutputSchema }),
  z.strictObject({ ...receipt, status: z.literal('failed'), error: codeboundErrorSchema }),
  z.strictObject({
    ...receipt, status: z.literal('cancelled'),
    error: codeboundErrorSchema.refine((value) => value.code === 'CANCELLED'),
  }),
]);
