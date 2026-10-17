// SPDX-License-Identifier: AGPL-3.0-only
import { ScriptExecutionService } from './script-execution.service';
import type { ExecutionPrincipal } from '../contracts';

describe('CODEBOUND orchestration (mocked persistence, Docker and gateway)', () => {
  const principal: ExecutionPrincipal = { userId: 'owner', organizationId: 'org', tokenIssuedAtMs: Date.now() - 1000,
    tokenExpiresAtMs: Date.now() + 120_000, origin: { kind: 'dashboard' } };
  const request = { scriptId: 'script', expectedRevision: 1, input: {} };
  const snapshot = { id: 'script', revision: 1, sourceSha256: 'a'.repeat(64), source: 'async function main() { return {}; }',
    binding: { toolId: 'tool', connectorId: 'connector' } };
  let service: ScriptExecutionService;
  let finalize: jest.Mock; let persistence: any; let gateway: any; let runner: any; let audit: any;
  beforeEach(() => {
    finalize = jest.fn().mockResolvedValue({ ok: true, value: null });
    persistence = { recoverInterruptedRuns: jest.fn().mockResolvedValue({ ok: true, value: null }),
      beginExecution: jest.fn().mockResolvedValue({ ok: true, value: { snapshot, finalize } }) };
    gateway = { open: jest.fn().mockResolvedValue({ ok: true, value: {} }), close: jest.fn().mockResolvedValue(undefined),
      call: jest.fn().mockResolvedValue({ type: 'connector.reply', requestId: '1', ok: true, value: { count: 2 } }) };
    runner = { execute: jest.fn().mockResolvedValue({ ok: true, value: { count: 2 } }) };
    audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    service = new ScriptExecutionService(persistence, gateway, runner, audit);
  });
  const execute = () => service.execute(principal, request, new AbortController().signal);

  it('passes only source/input/limits to runner, closes session, and finalizes only approved receipt fields', async () => {
    expect(await execute()).toMatchObject({ ok: true, value: { status: 'succeeded', output: { count: 2 } } });
    expect(Object.keys(runner.execute.mock.calls[0][0]).sort()).toEqual(['executionId', 'input', 'limits', 'source']);
    expect(gateway.open.mock.calls[0][3].cache).toBe('bypass');
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({ status: 'succeeded', metrics: expect.objectContaining({ outputBytes: 11 }) });
  });
  it.each(['SANDBOX_UNAVAILABLE', 'SCRIPT_ERROR'])('finalizes %s and closes the gateway', async code => {
    runner.execute.mockResolvedValue({ ok: false, error: { code, message: 'Execution failed' } });
    expect(await execute()).toMatchObject({ ok: true, value: { status: 'failed', error: { code } } });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: { code, message: 'Execution failed' } }));
    expect(gateway.close).toHaveBeenCalledTimes(1);
  });
  it('sanitizes unexpected exceptions and finalizes failed gateway opening', async () => {
    gateway.open.mockRejectedValue(new Error('credential-canary'));
    const result = await execute();
    expect(result).toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'INTERNAL_ERROR' } } });
    expect(JSON.stringify(result)).not.toContain('credential-canary');
    expect(finalize).toHaveBeenCalledTimes(1); expect(runner.execute).not.toHaveBeenCalled();
  });
  it('returns no success or output when receipt finalization fails', async () => {
    finalize.mockResolvedValue({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'DB failed' } });
    expect(await execute()).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Execution receipt could not be finalized' } });
  });
  it('preserves uncertain cleanup failure even when cancellation occurs', async () => {
    const controller = new AbortController();
    runner.execute.mockImplementation(async () => {
      controller.abort(); return { ok: false, error: { code: 'SANDBOX_UNAVAILABLE', message: 'Isolated execution unavailable' } };
    });
    expect(await service.execute(principal, request, controller.signal)).toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'SANDBOX_UNAVAILABLE' } } });
  });
  it('preserves gateway revocation errors despite runner flattening, and audits metadata only', async () => {
    gateway.call.mockResolvedValue({ type: 'connector.reply', requestId: '1', ok: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    runner.execute.mockImplementation(async (_: any, controls: any) => {
      await controls.onConnectorCall({ type: 'connector.call', requestId: '1', binding: 'connector.read', arguments: { secretInput: 'hidden' } });
      return { ok: false, error: { code: 'CONNECTOR_ERROR', message: 'Operation failed' } };
    });
    expect(await execute()).toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'FORBIDDEN' } } });
    expect(audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', organizationId: 'org', toolId: 'tool',
      deduplicate: false, status: 'ERROR', input: { executionId: expect.any(String) }, error: 'FORBIDDEN' }));
    expect(JSON.stringify(audit.logInvocation.mock.calls)).not.toContain('hidden');
  });
  it('bounds admission per owner and cancels active work on shutdown', async () => {
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    runner.execute.mockImplementation(async (_: any, controls: any) => {
      started(); await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, error: { code: 'CANCELLED', message: 'Cancelled' } };
    });
    const running = execute(); await began;
    expect(await execute()).toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
    await service.onModuleDestroy();
    expect(await running).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(gateway.close).toHaveBeenCalledTimes(1); expect(finalize).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid JSON and pre-cancelled requests without creating a run', async () => {
    expect(await service.execute(principal, { ...request, input: { nan: NaN } }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.execute(principal, request, AbortSignal.abort())).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(persistence.beginExecution).not.toHaveBeenCalled();
  });
  it('delivers connector IPC without awaiting a slow audit write', async () => {
    jest.useFakeTimers();
    let releaseAudit!: () => void;
    const receivedReply = jest.fn();
    audit.logInvocation.mockReturnValue(new Promise<void>(resolve => { releaseAudit = resolve; }));
    runner.execute.mockImplementation(async (_: any, controls: any) => {
      const reply = await controls.onConnectorCall({ type: 'connector.call', requestId: '1', binding: 'connector.read', arguments: {} });
      receivedReply(); return { ok: true, value: reply.value };
    });
    const running = execute();
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(receivedReply).toHaveBeenCalledTimes(1);
      expect(finalize).not.toHaveBeenCalled();
      releaseAudit();
      expect(await running).toMatchObject({ ok: true, value: { status: 'succeeded', output: { count: 2 } } });
    } finally { releaseAudit(); await running; jest.useRealTimers(); }
  });
  it('does not change successful connector execution into failure when audit rejects', async () => {
    audit.logInvocation.mockRejectedValue(new Error('audit-credential-canary'));
    runner.execute.mockImplementation(async (_: any, controls: any) => {
      await controls.onConnectorCall({ type: 'connector.call', requestId: '1', binding: 'connector.read', arguments: {} });
      return { ok: true, value: {} };
    });
    const result = await execute();
    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(JSON.stringify(result)).not.toContain('audit-credential-canary');
  });
});
