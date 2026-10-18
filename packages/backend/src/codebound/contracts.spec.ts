// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MVP_LIMITS } from './contracts';
import type {
  ScriptExecutionRequest, ScriptExecutionResult, SandboxConnectorCall,
  SandboxExecutionRequest, SupervisorConnectorReply,
} from './contracts';
import {
  codeboundErrorSchema, executionLimitsSchema, parseSandboxConnectorFrame,
  parseScriptSnapshot, sandboxConnectorCallSchema, sandboxExecutionRequestSchema,
  ScriptExecutionRequestDto, scriptExecutionRequestSchema,
  scriptExecutionResultSchema, scriptOutputSchema, supervisorConnectorReplySchema,
} from './contracts.validation';

const source = 'async function main(input, api) { return { count: 1 }; }';
const hash = createHash('sha256').update(source).digest('hex');
const snapshot = () => ({
  id: 'script-1', organizationId: 'org-1', ownerUserId: 'user-1', revision: 1,
  name: 'Task summary', description: 'Counts the returned tasks', source,
  sourceSha256: hash,
  inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
  outputSchema: { type: 'object' },
  binding: { connectorId: 'connector-1', toolId: 'tool-1', definitionSha256: 'a'.repeat(64) },
});
const request = () => ({ scriptId: 'script-1', expectedRevision: 1, input: {} });
const call = () => ({
  type: 'connector.call', requestId: 'request-1', binding: 'connector.read', arguments: {},
});
const receipt = () => ({
  executionId: 'execution-1', scriptId: 'script-1', revision: 1, sourceSha256: hash,
  metrics: { wallTimeMs: 10, connectorCalls: 1, connectorResponseBytes: 20, outputBytes: 2 },
});

describe('CODEBOUND shared boundary contracts', () => {
  it('parses detached public input with the shared TypeScript shape', () => {
    const original = { ...request(), input: { filter: { state: 'open' } } };
    const parsed: ScriptExecutionRequest = scriptExecutionRequestSchema.parse(original);
    original.input.filter.state = 'closed';
    expect(parsed.input).toEqual({ filter: { state: 'open' } });
  });

  it.each(['organizationId', 'userId', 'source', 'binding', 'limits'])(
    'rejects caller-supplied authority or policy: %s', (field) => {
      expect(scriptExecutionRequestSchema.safeParse({ ...request(), [field]: {} }).success).toBe(false);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', (value) => {
    expect(scriptExecutionRequestSchema.safeParse({ ...request(), expectedRevision: value }).success).toBe(false);
  });

  it('supports Nest class-validator DTOs with strict whitelisting', async () => {
    const options = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(ScriptExecutionRequestDto, request()), options)).toEqual([]);
    for (const invalid of [
      { ...request(), organizationId: 'foreign-org' },
      { ...request(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request(), input: [] },
      { ...request(), input: { text: 'x'.repeat(MVP_LIMITS.maxInputBytes) } },
    ]) {
      expect((await validate(plainToInstance(ScriptExecutionRequestDto, invalid), options)).length).toBeGreaterThan(0);
    }
  });

  it('measures output as serialized UTF-8 JSON, including quotes', () => {
    expect(scriptOutputSchema.safeParse('x'.repeat(16 * 1024 - 2)).success).toBe(true);
    expect(scriptOutputSchema.safeParse('x'.repeat(16 * 1024 - 1)).success).toBe(false);
    expect(scriptOutputSchema.safeParse('é'.repeat(8191)).success).toBe(true);
    expect(scriptOutputSchema.safeParse('é'.repeat(8192)).success).toBe(false);
  });

  it.each([undefined, NaN, Infinity, BigInt(1), () => 1, new Date(), new Map()])(
    'rejects unsupported JSON values: %s', (value) => {
      expect(scriptOutputSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects cycles, sparse arrays, dangerous keys and accessors without invoking them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getter = jest.fn(() => 'secret');
    const accessor = Object.defineProperty({}, 'value', { get: getter, enumerable: true });
    for (const value of [cyclic, Array(2), accessor, JSON.parse('{"__proto__":{}}')]) {
      expect(scriptOutputSchema.safeParse(value).success).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects excessive nesting before serialization', () => {
    let value: unknown = null;
    for (let i = 0; i < 40; i++) value = { child: value };
    expect(scriptOutputSchema.safeParse(value).success).toBe(false);
  });

  it('detaches and deeply freezes snapshots, including schemas and bindings', () => {
    const original = snapshot();
    const parsed = parseScriptSnapshot(original);
    original.inputSchema.properties.filter.type = 'number';
    original.binding.toolId = 'other-tool';
    expect(parsed.inputSchema).toEqual({ type: 'object', properties: { filter: { type: 'string' } } });
    expect(parsed.binding.toolId).toBe('tool-1');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.binding)).toBe(true);
    expect(Object.isFrozen(parsed.inputSchema.properties)).toBe(true);
  });

  it('rejects source/hash mismatches and unsupported manifest fields', () => {
    expect(() => parseScriptSnapshot({ ...snapshot(), source: source + ' ' })).toThrow();
    expect(() => parseScriptSnapshot({ ...snapshot(), bindings: [snapshot().binding] })).toThrow();
  });

  it('accepts MVP limits and rejects increases to any ceiling', () => {
    expect(executionLimitsSchema.parse(MVP_LIMITS)).toEqual(MVP_LIMITS);
    for (const [key, value] of Object.entries(MVP_LIMITS)) {
      expect(executionLimitsSchema.safeParse({ ...MVP_LIMITS, [key]: value + 1 }).success).toBe(false);
    }
    expect(executionLimitsSchema.safeParse({ ...MVP_LIMITS, cpuCores: 0 }).success).toBe(false);
  });

  it('validates sandbox requests and enforces lower per-execution limits', () => {
    const value = { executionId: 'execution-1', source, input: {}, limits: MVP_LIMITS };
    const parsed: SandboxExecutionRequest = sandboxExecutionRequestSchema.parse(value);
    expect(parsed.executionId).toBe('execution-1');
    expect(sandboxExecutionRequestSchema.safeParse({ ...value, principal: {} }).success).toBe(false);
    expect(sandboxExecutionRequestSchema.safeParse({ ...value, limits: { ...MVP_LIMITS, maxSourceBytes: 1 } }).success).toBe(false);
    expect(sandboxExecutionRequestSchema.safeParse({ ...value, limits: { ...MVP_LIMITS, maxInputBytes: 1 } }).success).toBe(false);
  });

  it('accepts legacy read or explicit names, while denying authority fields in IPC', () => {
    const parsed: SandboxConnectorCall = sandboxConnectorCallSchema.parse(call());
    expect(parsed.binding).toBe('connector.read');
    expect(sandboxConnectorCallSchema.safeParse({ ...call(), binding: 'connector.tool', toolName: 'approved_tool' }).success).toBe(true);
    expect(sandboxConnectorCallSchema.safeParse({ ...call(), binding: 'connector.tool' }).success).toBe(false);
    expect(sandboxConnectorCallSchema.safeParse({ ...call(), toolName: 'unexpected' }).success).toBe(false);
    for (const addition of [
      { binding: 'connector.write' }, { toolId: 'other-tool' }, { organizationId: 'other-org' },
      { executionId: 'other-run' }, { headers: {} }, { url: 'https://example.com' },
    ]) {
      expect(sandboxConnectorCallSchema.safeParse({ ...call(), ...addition }).success).toBe(false);
    }
  });

  it('checks frame bytes before parsing and suppresses parser input in errors', () => {
    expect(parseSandboxConnectorFrame(JSON.stringify(call()))).toEqual(call());
    expect(() => parseSandboxConnectorFrame(' '.repeat(MVP_LIMITS.maxIpcFrameBytes + 1))).toThrow('IPC frame exceeds byte limit');
    expect(() => parseSandboxConnectorFrame('not-json-secret')).toThrow('Invalid IPC JSON');
  });

  it('bounds replies and requires consistent error/limit pairs', () => {
    const parsed: SupervisorConnectorReply = supervisorConnectorReplySchema.parse({
      type: 'connector.reply', requestId: 'request-1', ok: true, value: { count: 1 },
    });
    expect(parsed.ok).toBe(true);
    expect(supervisorConnectorReplySchema.safeParse({
      ...parsed, value: 'x'.repeat(MVP_LIMITS.maxConnectorResponseBytes),
    }).success).toBe(false);
    expect(codeboundErrorSchema.safeParse({ code: 'RESOURCE_LIMIT', message: 'Limit reached', limit: 'memory' }).success).toBe(true);
    expect(codeboundErrorSchema.safeParse({ code: 'RESOURCE_LIMIT', message: 'Limit reached' }).success).toBe(false);
    expect(codeboundErrorSchema.safeParse({ code: 'FORBIDDEN', message: 'Denied', limit: 'memory' }).success).toBe(false);
    expect(codeboundErrorSchema.safeParse({ code: 'INTERNAL_ERROR', message: 'x'.repeat(513) }).success).toBe(false);
  });

  it('keeps result variants distinct, with bounded JSON and no partial failure output', () => {
    const parsed: ScriptExecutionResult = scriptExecutionResultSchema.parse({ ...receipt(), status: 'succeeded', output: {} });
    expect(parsed.status).toBe('succeeded');
    expect(scriptExecutionResultSchema.safeParse({ ...receipt(), status: 'failed', error: { code: 'SCRIPT_ERROR', message: 'Failed' } }).success).toBe(true);
    expect(scriptExecutionResultSchema.safeParse({ ...receipt(), status: 'failed', output: {}, error: { code: 'SCRIPT_ERROR', message: 'Failed' } }).success).toBe(false);
    expect(scriptExecutionResultSchema.safeParse({ ...receipt(), status: 'cancelled', error: { code: 'FORBIDDEN', message: 'Denied' } }).success).toBe(false);
    expect(scriptExecutionResultSchema.safeParse({ ...receipt(), status: 'succeeded', output: 'x'.repeat(16 * 1024) }).success).toBe(false);
  });
});
