// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { Logger } from '@nestjs/common';
import { DockerSandboxRunner } from './docker-sandbox-runner';
import { MVP_LIMITS } from '../contracts';
import type { SandboxExecutionRequest } from '../contracts';

jest.mock('node:child_process', () => ({ execFile: jest.fn(), spawn: jest.fn() }));

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn();
  frame(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
}

describe('DockerSandboxRunner supervisor boundaries (no Docker)', () => {
  let child: FakeChild;
  let start: () => void;
  let command: (args: string[]) => string;
  const request = (limits: Partial<SandboxExecutionRequest['limits']> = {}): SandboxExecutionRequest => ({
    executionId: 'fixture-run', source: 'async function main(){return {};}', input: {},
    limits: { ...MVP_LIMITS, ...limits },
  });
  const controls = () => ({ signal: new AbortController().signal, onConnectorCall: jest.fn() });
  beforeEach(() => {
    jest.clearAllMocks();
    child = new FakeChild();
    start = () => { child.frame({ type: 'result', output: { count: 1 } }); child.emit('close', 0); };
    command = (args) => args[0] === 'info' ? 'linux' : args[0] === 'inspect' ? 'false' : '';
    (execFile as unknown as jest.Mock).mockImplementation((_file, args, _options, callback) => {
      queueMicrotask(() => {
        try { callback(null, command(args)); } catch (error) { callback(error, ''); }
      });
    });
    (spawn as unknown as jest.Mock).mockImplementation(() => {
      queueMicrotask(() => {
        child.emit('spawn'); child.frame({ type: 'ready' }); start();
      });
      return child;
    });
  });

  it('applies mandatory isolation flags and removes the exact random container', async () => {
    expect(await new DockerSandboxRunner().execute(request(), controls())).toEqual({ ok: true, value: { count: 1 } });
    const calls = (execFile as unknown as jest.Mock).mock.calls.map((call) => call[1] as string[]);
    const create = calls.find((args) => args[0] === 'create')!;
    const name = create[create.indexOf('--name') + 1];
    expect(name).toMatch(/^codebound-[a-f0-9-]+$/);
    for (const flag of ['--read-only', '--pull', '--cap-drop', '--security-opt', '--pids-limit', '--memory-swap']) expect(create).toContain(flag);
    expect(create).not.toContain('--init'); // The image watchdog must be namespace PID 1.
    expect(create.slice(create.indexOf('--tmpfs'), create.indexOf('--tmpfs') + 2)).toEqual([
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=65534,gid=65534',
    ]);
    expect(create.filter(flag => flag === '--tmpfs')).toHaveLength(1);
    expect(create.slice(create.indexOf('--network'), create.indexOf('--network') + 2)).toEqual(['--network', 'none']);
    for (const forbidden of ['--volume', '-v', '--mount', '--env-file', '--privileged', '--publish']) expect(create).not.toContain(forbidden);
    const env = create.flatMap((value, index) => value === '--env' ? [create[index + 1]] : []);
    expect(env.sort()).toEqual(['HTTP_PROXY=', 'HTTPS_PROXY=', 'FTP_PROXY=', 'NO_PROXY=', 'ALL_PROXY=',
      'http_proxy=', 'https_proxy=', 'ftp_proxy=', 'no_proxy=', 'all_proxy='].sort());
    expect(calls).toContainEqual(['rm', '--force', name]);
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects invalid input and pre-cancelled requests without launching Docker', async () => {
    expect(await new DockerSandboxRunner().execute({ ...request(), input: { bad: undefined } } as any, controls()))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await new DockerSandboxRunner().execute(request(), { ...controls(), signal: AbortSignal.abort() }))
      .toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable Docker or non-Linux engines', async () => {
    command = () => { throw new Error('secret-host-details'); };
    const result = await new DockerSandboxRunner().execute(request(), controls());
    expect(result).toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('secret-host-details');
    command = (args) => args[0] === 'info' ? 'windows' : '';
    expect(await new DockerSandboxRunner().execute(request(), controls()))
      .toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires actual container readiness rather than CLI spawn', async () => {
    (spawn as unknown as jest.Mock).mockImplementation(() => {
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 125); }); return child;
    });
    expect(await new DockerSandboxRunner().execute(request(), controls()))
      .toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
  });

  it.each(['info', 'create'])('does not start a container after cancellation during %s', async (stage) => {
    const controller = new AbortController();
    command = (args) => {
      if (args[0] === stage) controller.abort();
      return args[0] === 'info' ? 'linux' : '';
    };
    expect(await new DockerSandboxRunner().execute(request(), { ...controls(), signal: controller.signal }))
      .toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not send source if cancellation races with Docker start', async () => {
    const controller = new AbortController();
    const write = jest.spyOn(child.stdin, 'write');
    (spawn as unknown as jest.Mock).mockImplementation(() => {
      controller.abort();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    expect(await new DockerSandboxRunner().execute(request(), { ...controls(), signal: controller.signal }))
      .toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects mismatched connector reply IDs and never forwards error details', async () => {
    start = () => child.frame({ type: 'connector.call', requestId: 'expected', binding: 'connector.read', arguments: {} });
    const onConnectorCall = jest.fn(async () => ({ type: 'connector.reply' as const, requestId: 'foreign', ok: true as const, value: { private: true } }));
    expect(await new DockerSandboxRunner().execute(request(), { ...controls(), onConnectorCall }))
      .toMatchObject({ ok: false, error: { code: 'CONNECTOR_ERROR' } });
    expect(child.stdin.read()?.toString() ?? '').not.toContain('private');
  });

  it('limits frames across arbitrary chunk boundaries before JSON parsing', async () => {
    start = () => { child.stdout.write(Buffer.alloc(800, 120)); child.stdout.write(Buffer.alloc(800, 120)); };
    expect(await new DockerSandboxRunner().execute(request({ maxIpcFrameBytes: 1400 }), controls()))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'ipcFrameBytes' } });
  });

  it('decodes fragmented UTF-8 frames and rejects partial trailing frames', async () => {
    start = () => {
      const frame = Buffer.from(JSON.stringify({ type: 'result', output: 'é' }) + '\n');
      for (const byte of frame) child.stdout.write(Buffer.from([byte]));
      child.emit('close', 0);
    };
    expect(await new DockerSandboxRunner().execute(request(), controls())).toEqual({ ok: true, value: 'é' });
    start = () => { child.stdout.write('{'); child.emit('close', 0); };
    expect(await new DockerSandboxRunner().execute(request(), controls())).toMatchObject({ ok: false });
  });

  it('rejects forged second calls before invoking the fake gateway twice', async () => {
    start = () => {
      for (const requestId of ['a', 'b']) child.frame({ type: 'connector.call', requestId, binding: 'connector.read', arguments: {} });
    };
    const control = { ...controls(), onConnectorCall: jest.fn(() => new Promise<any>(() => {})) };
    expect(await new DockerSandboxRunner().execute(request(), control))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorCalls' } });
    expect(control.onConnectorCall.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('bounds connector replies and sanitizes callback failures', async () => {
    start = () => child.frame({ type: 'connector.call', requestId: 'a', binding: 'connector.read', arguments: {} });
    const onConnectorCall = jest.fn(async () => ({ type: 'connector.reply' as const, requestId: 'a', ok: true as const, value: { data: 'too large' } }));
    expect(await new DockerSandboxRunner().execute(request({ maxConnectorResponseBytes: 2 }), { ...controls(), onConnectorCall }))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorResponseBytes' } });
    onConnectorCall.mockRejectedValueOnce(new Error('secret-credential'));
    const result = await new DockerSandboxRunner().execute(request(), { ...controls(), onConnectorCall });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTOR_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('secret-credential');
  });

  it('enforces deadline and log limits outside the container', async () => {
    start = () => {};
    expect(await new DockerSandboxRunner().execute(request({ wallTimeMs: 30 }), controls()))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'wallTime' } });
    start = () => child.stderr.write('secret-flood');
    expect(await new DockerSandboxRunner().execute(request({ maxLogBytes: 1 }), controls()))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'logBytes' } });
  });

  it('does not return success when cleanup fails and disables the runner', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    command = (args) => {
      if (args[0] === 'rm') throw new Error('unavailable');
      return args[0] === 'info' ? 'linux' : 'container-still-present';
    };
    try {
      const runner = new DockerSandboxRunner();
      expect(await runner.execute(request(), controls())).toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
      const count = (execFile as unknown as jest.Mock).mock.calls.length;
      expect(await runner.execute(request(), controls())).toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
      expect((execFile as unknown as jest.Mock).mock.calls).toHaveLength(count);
    } finally { logger.mockRestore(); }
  });
});
