// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { ScriptPersistenceService } from '../persistence/script-persistence.service';
import { AuthorizedConnectorGatewayService } from '../gateway/authorized-connector-gateway.service';
import { DockerSandboxRunner } from '../sandbox/docker-sandbox-runner';
import { MVP_LIMITS } from '../contracts';
import type { CodeboundError, ExecutionPrincipal, GatewaySession, JsonValue, Outcome, ScriptExecutionRequest, ScriptExecutionResult } from '../contracts';
import { scriptExecutionRequestSchema, scriptExecutionResultSchema, scriptOutputSchema, supervisorConnectorReplySchema } from '../contracts.validation';

const failure = (code: CodeboundError['code'], message: string): Outcome<never> => ({ ok: false, error: { code, message } });
const bytes = (value: JsonValue) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The only evaluator is DockerSandboxRunner. This process handles trusted policy
 * and bounded JSON, never executes script source or stores input/output.
 */
@Injectable()
export class ScriptExecutionService implements OnModuleDestroy {
  private readonly logger = new Logger(ScriptExecutionService.name);
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private readonly owners = new Set<string>();
  private stopping = false;

  constructor(private readonly persistence: ScriptPersistenceService,
    private readonly gateway: AuthorizedConnectorGatewayService,
    private readonly runner: DockerSandboxRunner,
    private readonly audit: AuditService) {}

  async onModuleDestroy() {
    this.stopping = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }

  async execute(principal: ExecutionPrincipal, request: ScriptExecutionRequest, signal: AbortSignal): Promise<Outcome<ScriptExecutionResult>> {
    const parsed = scriptExecutionRequestSchema.safeParse(request);
    if (!parsed.success) return failure('INVALID_INPUT', 'Invalid execution request');
    // Bounded admission, no queue. Limits are per backend process, not global.
    const owner = JSON.stringify([principal.organizationId, principal.userId]);
    if (this.stopping || this.active.size >= 2 || this.owners.has(owner)) return failure('SANDBOX_UNAVAILABLE', 'Execution capacity unavailable');
    const controller = new AbortController();
    this.owners.add(owner);
    const operation = this.run(structuredClone(principal), parsed.data, AbortSignal.any([signal, controller.signal]));
    this.active.set(controller, operation);
    try { return await operation; }
    finally { this.active.delete(controller); this.owners.delete(owner); }
  }

  private async run(principal: ExecutionPrincipal, request: ScriptExecutionRequest, parent: AbortSignal): Promise<Outcome<ScriptExecutionResult>> {
    if (parent.aborted) return failure('CANCELLED', 'Execution cancelled');
    const recovery = await this.persistence.recoverInterruptedRuns(principal);
    if (!recovery.ok) return recovery;
    const executionId = randomUUID();
    const begun = await this.persistence.beginExecution(principal, request.scriptId, request.expectedRevision, executionId);
    if (!begun.ok) return begun;
    const { snapshot, finalize } = begun.value;
    const started = Date.now();
    const deadlineEpochMs = started + MVP_LIMITS.wallTimeMs;
    const deadline = AbortSignal.timeout(MVP_LIMITS.wallTimeMs);
    const expired = AbortSignal.timeout(Math.max(0, Math.min(2_147_483_647, principal.tokenExpiresAtMs - started)));
    const stopped = new AbortController();
    const signal = AbortSignal.any([parent, deadline, expired, stopped.signal]);
    const metrics = { wallTimeMs: 0, connectorCalls: 0, connectorResponseBytes: 0, outputBytes: 0 };
    let session: GatewaySession | undefined;
    let connectorError: CodeboundError | undefined;
    let outcome: Outcome<JsonValue> = failure('INTERNAL_ERROR', 'Execution failed');
    const pending = new Set<Promise<unknown>>();
    const audits = new Set<Promise<void>>();
    try {
      const opened = await this.gateway.open(principal, snapshot, executionId, {
        signal, deadlineEpochMs, maxResponseBytes: MVP_LIMITS.maxConnectorResponseBytes, cache: 'bypass',
      });
      if (!opened.ok) outcome = opened;
      else {
        session = opened.value;
        outcome = await this.runner.execute({ executionId, source: snapshot.source, input: request.input, limits: MVP_LIMITS }, {
          signal,
          onConnectorCall: call => {
            const invoke = async () => {
              // Defense in depth: never rely only on the untrusted process budget.
              if (metrics.connectorCalls >= 1) return { type: 'connector.reply' as const, requestId: call.requestId,
                error: { code: 'RESOURCE_LIMIT' as const, message: 'Connector call limit exceeded', limit: 'connectorCalls' as const }, ok: false as const };
              metrics.connectorCalls++;
              const callStarted = Date.now();
              const reply = supervisorConnectorReplySchema.parse(await this.gateway.call(session!, call));
              if (reply.ok) metrics.connectorResponseBytes = bytes(reply.value);
              else connectorError = reply.error;
              // Metadata only. No arguments, source, credentials or response content.
              const audit = this.audit.logInvocation({ toolId: snapshot.binding.toolId, connectorId: snapshot.binding.connectorId,
                organizationId: principal.organizationId, userId: principal.userId,
                mcpServerId: principal.origin.kind === 'mcp' ? principal.origin.serverId : undefined,
                input: { executionId }, clientInfo: `codebound/${executionId}`, deduplicate: false,
                status: reply.ok ? 'SUCCESS' : reply.error.limit === 'wallTime' ? 'TIMEOUT' : 'ERROR',
                durationMs: Date.now() - callStarted, error: reply.ok ? undefined : reply.error.code });
              // Existing audit writes are best effort and cannot be cancelled.
              // Audit availability must not hold up sandbox IPC or consume
              // the script's execution deadline. Await the bounded write only
              // after the execution outcome has been determined.
              const auditing = this.boundedAudit(audit);
              audits.add(auditing);
              void auditing.finally(() => audits.delete(auditing));
              return reply;
            };
            const operation = invoke();
            pending.add(operation);
            void operation.finally(() => pending.delete(operation)).catch(() => {});
            return operation;
          },
        });
        if (connectorError && (outcome.ok || outcome.error.code !== 'SANDBOX_UNAVAILABLE')) outcome = { ok: false, error: connectorError };
      }
    } catch { outcome = failure('INTERNAL_ERROR', 'Execution failed'); }
    finally {
      stopped.abort();
      if (session) {
        try { await this.gateway.close(session); }
        catch { outcome = failure('INTERNAL_ERROR', 'Execution cleanup failed'); }
      }
      await Promise.allSettled(pending);
    }
    if (!outcome.ok && outcome.error.code === 'SANDBOX_UNAVAILABLE') { /* Preserve uncertain-isolation/cleanup failures. */ }
    else if (parent.aborted) outcome = failure('CANCELLED', 'Execution cancelled');
    else if (expired.aborted) outcome = failure('FORBIDDEN', 'Execution authorization expired');
    else if (deadline.aborted) outcome = { ok: false, error: { code: 'RESOURCE_LIMIT', message: 'Execution limit exceeded', limit: 'wallTime' } };
    if (outcome.ok) {
      const output = scriptOutputSchema.safeParse(outcome.value);
      if (output.success) { outcome = { ok: true, value: output.data }; metrics.outputBytes = bytes(output.data); }
      else outcome = failure('INVALID_OUTPUT', 'Invalid script output');
    }
    metrics.wallTimeMs = Math.min(86_400_000, Math.max(0, Date.now() - started));
    const result: ScriptExecutionResult = {
      executionId, scriptId: snapshot.id, revision: snapshot.revision, sourceSha256: snapshot.sourceSha256, metrics,
      ...(outcome.ok ? { status: 'succeeded' as const, output: outcome.value }
        : { status: outcome.error.code === 'CANCELLED' ? 'cancelled' as const : 'failed' as const, error: outcome.error }),
    };
    const checked = scriptExecutionResultSchema.safeParse(result);
    const completion = checked.success ? { status: result.status, metrics, ...('error' in result ? { error: result.error } : {}) } : { status: 'failed' as const, metrics,
      error: { code: 'INTERNAL_ERROR' as const, message: 'Execution failed' } };
    await Promise.allSettled(audits);
    const finished = await finalize(completion);
    if (!finished.ok) {
      this.logger.error(`CODEBOUND receipt finalization failed: ${executionId}`);
      return failure('INTERNAL_ERROR', 'Execution receipt could not be finalized');
    }
    return checked.success ? { ok: true, value: checked.data } : failure('INTERNAL_ERROR', 'Invalid execution result');
  }

  private async boundedAudit(operation: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([operation, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
    catch { this.logger.warn('CODEBOUND invocation audit unavailable'); }
    finally { if (timer) clearTimeout(timer); }
  }
}
