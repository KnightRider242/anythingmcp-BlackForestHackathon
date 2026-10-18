// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MVP_LIMITS } from '../contracts';
import type {
  AuthorizedConnectorGateway, CodeboundError, ConnectorCallControls, ExecutionPrincipal,
  GatewaySession, Outcome, SandboxConnectorCall, ScriptSnapshot, SupervisorConnectorReply, ReadToolBinding,
} from '../contracts';
import { parseScriptSnapshot, sandboxConnectorCallSchema, supervisorConnectorReplySchema } from '../contracts.validation';
import { BoundReadAuthorization } from './bound-read-authorization.service';
import { BoundRestExecutor, ConnectorResponseLimitError, ConnectorUpstreamError } from './bound-rest-executor.service';

const id = z.string().min(1).max(128);
const principalSchema = z.strictObject({
  userId: id, organizationId: id,
  tokenIssuedAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tokenExpiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dashboard') }),
    z.strictObject({ kind: z.literal('mcp'), serverId: id, oauthClientId: id.nullable(), apiKeyId: id.optional() }),
  ]),
});

interface State {
  principal: ExecutionPrincipal;
  script: ScriptSnapshot;
  controls: ConnectorCallControls;
  controller: AbortController;
  calls: number;
  busy: boolean;
  responseBytes: number;
  bindings: Map<string, Readonly<ReadToolBinding>>;
  requestIds: Set<string>;
}

/** Does not cancel a DB query, but never dispatches HTTP when it finishes late. */
function within<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Stopped'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

@Injectable()
export class AuthorizedConnectorGatewayService implements AuthorizedConnectorGateway {
  private readonly sessions = new WeakMap<GatewaySession, State>();
  // Retain execution IDs through their deadline, including after close, to deny reopen/replay.
  private readonly executions = new Map<string, number>();
  constructor(private readonly authorization: BoundReadAuthorization, private readonly executor: BoundRestExecutor) {}

  async open(principal: ExecutionPrincipal, script: ScriptSnapshot, executionId: string, controls: ConnectorCallControls): Promise<Outcome<GatewaySession>> {
    let snapshot: ScriptSnapshot;
    let caller: ExecutionPrincipal;
    try {
      caller = principalSchema.parse(principal);
      snapshot = parseScriptSnapshot(script);
      id.parse(executionId);
      z.number().int().positive().max(MVP_LIMITS.maxConnectorResponseBytes).parse(controls.maxResponseBytes);
      if (!(controls.signal instanceof AbortSignal) || controls.cache !== 'bypass' || !Number.isSafeInteger(controls.deadlineEpochMs) ||
          controls.deadlineEpochMs <= Date.now() || controls.deadlineEpochMs > Date.now() + MVP_LIMITS.wallTimeMs ||
          caller.tokenExpiresAtMs <= caller.tokenIssuedAtMs) throw new Error('Invalid controls');
    } catch { return { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid gateway request' } }; }
    if (controls.signal.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'Execution cancelled' } };
    for (const [key, expiry] of this.executions) if (expiry <= Date.now()) this.executions.delete(key);
    const key = JSON.stringify([caller.organizationId, caller.userId, executionId]);
    if (this.executions.has(key)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Execution already opened' } };
    this.executions.set(key, controls.deadlineEpochMs);
    const controller = new AbortController();
    const deadlineEpochMs = Math.min(controls.deadlineEpochMs, caller.tokenExpiresAtMs);
    const signal = AbortSignal.any([controls.signal, controller.signal,
      AbortSignal.timeout(Math.max(1, deadlineEpochMs - Date.now()))]);
    const state: State = { principal: caller, script: snapshot, controller, calls: 0, busy: false, responseBytes: 0,
      bindings: new Map(), requestIds: new Set(),
      controls: { signal, deadlineEpochMs, maxResponseBytes: controls.maxResponseBytes, cache: 'bypass' } };
    try {
      for (const binding of [snapshot.binding, ...(snapshot.additionalBindings ?? [])]) {
        const tool = await within(signal, () => this.authorization.authorize(caller, snapshot, undefined, binding));
        if (state.bindings.has(tool.name)) throw new Error('Ambiguous tool');
        state.bindings.set(tool.name, binding);
      }
      signal.throwIfAborted();
      const session = Object.freeze({}) as GatewaySession;
      this.sessions.set(session, state);
      return { ok: true, value: session };
    } catch {
      controller.abort();
      return { ok: false, error: controls.signal.aborted ? { code: 'CANCELLED', message: 'Execution cancelled' }
        : Date.now() >= controls.deadlineEpochMs ? { code: 'RESOURCE_LIMIT', message: 'Execution deadline exceeded', limit: 'wallTime' }
          : { code: 'FORBIDDEN', message: 'Connector access denied' } };
    }
  }

  async call(session: GatewaySession, rawCall: SandboxConnectorCall): Promise<SupervisorConnectorReply> {
    const parsed = sandboxConnectorCallSchema.safeParse(rawCall);
    const requestId = parsed.success ? parsed.data.requestId : 'invalid';
    const error = (value: CodeboundError): SupervisorConnectorReply => supervisorConnectorReplySchema.parse({
      type: 'connector.reply', requestId, ok: false, error: value,
    });
    const state = this.sessions.get(session);
    if (!state) return error({ code: 'FORBIDDEN', message: 'Execution not available' });
    if (state.busy || state.calls >= MVP_LIMITS.maxConnectorCalls || state.requestIds.has(requestId)) {
      state.controller.abort();
      return error({ code: 'RESOURCE_LIMIT', message: 'Connector call limit exceeded', limit: 'connectorCalls' });
    }
    state.calls++;
    state.requestIds.add(requestId);
    if (!parsed.success) { state.controller.abort(); return error({ code: 'INVALID_INPUT', message: 'Invalid connector call' }); }
    const { principal, script, controls } = state;
    const selected = parsed.data.binding === 'connector.read' ? script.binding : state.bindings.get(parsed.data.toolName!);
    if (!selected) { state.controller.abort(); return error({ code: 'FORBIDDEN', message: 'Connector access denied' }); }
    state.busy = true;
    const stopped = (): CodeboundError => Date.now() >= principal.tokenExpiresAtMs
      ? { code: 'FORBIDDEN', message: 'Connector access denied' }
      : Date.now() >= controls.deadlineEpochMs
      ? { code: 'RESOURCE_LIMIT', message: 'Execution deadline exceeded', limit: 'wallTime' }
      : { code: 'CANCELLED', message: 'Execution cancelled' };
    let authorized = false;
    try {
      // Re-read every capability on every call; a routing name is never authority.
      let tool;
      for (const binding of [script.binding, ...(script.additionalBindings ?? [])]) {
        const live = await within(controls.signal, () => this.authorization.authorize(principal, script, undefined, binding));
        if (binding.toolId === selected.toolId) tool = live;
      }
      if (!tool || (parsed.data.binding === 'connector.tool' && tool.name !== parsed.data.toolName)) throw new Error('Denied');
      controls.signal.throwIfAborted();
      authorized = true;
      const remainingBytes = MVP_LIMITS.maxTotalConnectorResponseBytes - state.responseBytes;
      if (remainingBytes <= 0) throw new ConnectorResponseLimitError();
      const value = await within(controls.signal, () => this.executor.execute(tool, parsed.data.arguments, principal, {
        ...controls, maxResponseBytes: Math.min(controls.maxResponseBytes, remainingBytes),
        recordResponseBytes: bytes => {
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remainingBytes) throw new ConnectorResponseLimitError();
          state.responseBytes += bytes;
        },
      }));
      controls.signal.throwIfAborted();
      const reply = supervisorConnectorReplySchema.parse({ type: 'connector.reply', requestId, ok: true, value });
      if (Buffer.byteLength(JSON.stringify(value)) > controls.maxResponseBytes) throw new ConnectorResponseLimitError();
      return reply;
    } catch (cause) {
      if (controls.signal.aborted) return error(stopped());
      if (cause instanceof ConnectorUpstreamError) return { ...error({ code: 'CONNECTOR_ERROR', message: 'Connector operation failed' }), recoverable: true };
      state.controller.abort();
      if (cause instanceof ConnectorResponseLimitError) return error({ code: 'RESOURCE_LIMIT', message: 'Connector response limit exceeded', limit: 'connectorResponseBytes' });
      return error({ code: authorized ? 'CONNECTOR_ERROR' : 'FORBIDDEN', message: authorized ? 'Connector operation failed' : 'Connector access denied' });
    } finally { state.busy = false; }
  }

  bindingFor(session: GatewaySession, call: SandboxConnectorCall): Readonly<ReadToolBinding> | undefined {
    const state = this.sessions.get(session);
    return call.binding === 'connector.read' ? state?.script.binding : state?.bindings.get(call.toolName ?? '');
  }

  responseBytes(session: GatewaySession): number { return this.sessions.get(session)?.responseBytes ?? 0; }

  async close(session: GatewaySession): Promise<void> {
    const state = this.sessions.get(session);
    state?.controller.abort();
    this.sessions.delete(session);
  }
}
