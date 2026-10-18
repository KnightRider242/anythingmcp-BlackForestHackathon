// SPDX-License-Identifier: AGPL-3.0-only

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type ReadonlyJsonValue =
  | null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJsonValue }

export type ErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'VERSION_CONFLICT'
  | 'SCRIPT_ERROR' | 'CONNECTOR_ERROR' | 'INVALID_OUTPUT' | 'RESOURCE_LIMIT'
  | 'CANCELLED' | 'SANDBOX_UNAVAILABLE' | 'INTERNAL_ERROR';

export type ResourceLimit =
  | 'wallTime' | 'memory' | 'processes' | 'sourceBytes' | 'inputBytes'
  | 'outputBytes' | 'ipcFrameBytes' | 'connectorCalls'
  | 'connectorResponseBytes' | 'logBytes';

/** Public messages must be sanitized; validation cannot establish redaction. */
export interface CodeboundError {
  code: ErrorCode;
  message: string;
  limit?: ResourceLimit;
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: CodeboundError };

/** Trusted policy only. Callers may not increase these ceilings. */
export interface ExecutionLimits {
  wallTimeMs: number;
  memoryBytes: number;
  cpuCores: number;
  maxProcesses: number;
  maxSourceBytes: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxIpcFrameBytes: number;
  maxConnectorCalls: number;
  maxConnectorResponseBytes: number;
  maxTotalConnectorResponseBytes: number;
  maxLogBytes: number;
}

export const MVP_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  wallTimeMs: 30_000,
  memoryBytes: 128 * 1024 * 1024,
  cpuCores: 0.5,
  maxProcesses: 16,
  maxSourceBytes: 32 * 1024,
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxIpcFrameBytes: 600 * 1024,
  maxConnectorCalls: 128,
  maxConnectorResponseBytes: 512 * 1024,
  maxTotalConnectorResponseBytes: 8 * 1024 * 1024,
  maxLogBytes: 4 * 1024,
});

/** Public input; identity, source, binding and limits come from trusted code. */
export interface ScriptExecutionRequest {
  scriptId: string;
  expectedRevision: number;
  input: JsonObject;
}

export interface ExecutionMetrics {
  wallTimeMs: number;
  connectorCalls: number;
  connectorResponseBytes: number;
  outputBytes: number;
}

export interface ExecutionReceipt {
  executionId: string;
  scriptId: string;
  revision: number;
  sourceSha256: string;
  metrics: ExecutionMetrics;
}

export type ScriptExecutionResult = ExecutionReceipt & (
  | { status: 'succeeded'; output: JsonValue }
  | { status: 'failed'; error: CodeboundError }
  | { status: 'cancelled'; error: CodeboundError }
);

/** The sandbox receives no principal, connector configuration or secrets. */
export interface SandboxExecutionRequest {
  executionId: string;
  source: string;
  input: JsonObject;
  limits: Readonly<ExecutionLimits>;
}

export interface SandboxConnectorCall {
  type: 'connector.call';
  requestId: string;
  binding: 'connector.read' | 'connector.tool';
  toolName?: string;
  arguments: JsonObject;
}

export type SupervisorConnectorReply = {
  type: 'connector.reply';
  requestId: string;
  recoverable?: true;
} & Outcome<JsonValue>;

export interface ScriptApi {
  read(arguments_: JsonObject): Promise<JsonValue>;
  call(toolName: string, arguments_: JsonObject): Promise<JsonValue>;
}

/** Source defines async function main(input, api). No streaming contract. */
export type ScriptMain = (input: JsonObject, api: ScriptApi) => Promise<JsonValue>;

export interface SandboxControls {
  signal: AbortSignal;
  onConnectorCall(call: SandboxConnectorCall): Promise<SupervisorConnectorReply>;
}

/** Implementations must fail closed with SANDBOX_UNAVAILABLE, never run inline. */
export interface SandboxRunner {
  execute(
    request: SandboxExecutionRequest,
    controls: SandboxControls,
  ): Promise<Outcome<JsonValue>>;
}

/** Backend-only, derived from verified JWT authentication, never a wire DTO. */
export interface ExecutionPrincipal {
  userId: string;
  organizationId: string;
  tokenIssuedAtMs: number;
  tokenExpiresAtMs: number;
  origin:
    | { kind: 'dashboard' }
    | { kind: 'mcp'; serverId: string; oauthClientId: string | null; apiKeyId?: string };
}

/** One backend-approved REST GET/POST capability, not an MCP annotation. */
export interface ReadToolBinding {
  connectorId: string;
  toolId: string;
  definitionSha256: string;
}

declare const gatewaySessionBrand: unique symbol;
export type GatewaySession = { readonly [gatewaySessionBrand]: true };

export interface ConnectorCallControls {
  signal: AbortSignal;
  deadlineEpochMs: number;
  maxResponseBytes: number;
  cache: 'bypass';
  recordResponseBytes?: (bytes: number) => void;
}

/**
 * open AND call must revalidate live membership, revocation, roles, grants,
 * server scope, enabled state and binding. Snapshot ownership is not authority.
 * Owner-only execution is an MVP restriction, not marketplace ownership policy.
 */
export interface AuthorizedConnectorGateway {
  open(
    principal: ExecutionPrincipal,
    script: ScriptSnapshot,
    executionId: string,
    controls: ConnectorCallControls,
  ): Promise<Outcome<GatewaySession>>;
  call(session: GatewaySession, call: SandboxConnectorCall): Promise<SupervisorConnectorReply>;
  close(session: GatewaySession): Promise<void>;
}

export interface ScriptDefinition {
  name: string;
  description: string;
  source: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  binding: ReadToolBinding;
  additionalBindings?: ReadToolBinding[];
}

export type ScriptSnapshot = Readonly<Omit<ScriptDefinition, 'inputSchema' | 'outputSchema' | 'binding'> & {
  inputSchema: ReadonlyJsonObject;
  outputSchema: ReadonlyJsonObject;
  binding: Readonly<ReadToolBinding>;
  id: string;
  organizationId: string;
  ownerUserId: string;
  revision: number;
  sourceSha256: string;
}>;

/**
 * Revision starts at 1. Updates/deletes compare expectedRevision atomically.
 * Execution copies/freezes a snapshot; live authorization remains independent.
 * Every organization-scoped operation must filter by organizationId.
 */
export interface ScriptLifecycle {
  create(principal: ExecutionPrincipal, definition: ScriptDefinition): Promise<Outcome<ScriptSnapshot>>;
  get(principal: ExecutionPrincipal, scriptId: string): Promise<Outcome<ScriptSnapshot>>;
  update(
    principal: ExecutionPrincipal,
    scriptId: string,
    expectedRevision: number,
    replacement: ScriptDefinition,
  ): Promise<Outcome<ScriptSnapshot>>;
  remove(
    principal: ExecutionPrincipal,
    scriptId: string,
    expectedRevision: number,
  ): Promise<Outcome<null>>;
  execute(
    principal: ExecutionPrincipal,
    request: ScriptExecutionRequest,
    signal: AbortSignal,
  ): Promise<Outcome<ScriptExecutionResult>>;
}
