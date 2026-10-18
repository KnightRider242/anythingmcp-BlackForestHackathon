// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  CodeboundError, JsonValue, Outcome, ResourceLimit, SandboxControls,
  SandboxExecutionRequest, SandboxRunner,
} from '../contracts';
import {
  sandboxExecutionRequestSchema, sandboxConnectorCallSchema,
  scriptOutputSchema, supervisorConnectorReplySchema,
} from '../contracts.validation';

const resultFrame = z.strictObject({ type: z.literal('result'), output: scriptOutputSchema });
const errorFrame = z.discriminatedUnion('code', [
  z.strictObject({ type: z.literal('error'), code: z.literal('RESOURCE_LIMIT'), limit: z.enum(['connectorCalls', 'outputBytes']) }),
  z.strictObject({ type: z.literal('error'), code: z.enum(['SCRIPT_ERROR', 'INVALID_OUTPUT']) }),
]);
const failure = (code: CodeboundError['code'], message: string, limit?: ResourceLimit): Outcome<JsonValue> =>
  ({ ok: false, error: { code, message, ...(limit ? { limit } : {}) } });
const limited = (limit: ResourceLimit) => failure('RESOURCE_LIMIT', 'Execution limit exceeded', limit);
// Docker CLI config.json can inject proxy URLs (including credentials) by default.
const emptyProxyEnvironment = ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'ftp_proxy', 'no_proxy', 'all_proxy']
  .flatMap((key) => ['--env', `${key}=`]);

/** Trusted supervisor adapter. Do not expose Docker access to HTTP or scripts. */
export class DockerSandboxRunner implements SandboxRunner {
  private readonly logger = new Logger(DockerSandboxRunner.name);
  private unhealthy = false;

  constructor(private readonly options: { image?: string; dockerBinary?: string } = {}) {}

  private command(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.options.dockerBinary ?? 'docker', args, {
        timeout: Math.max(1, timeout), maxBuffer: 8192, windowsHide: true,
      }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    });
  }

  async execute(raw: SandboxExecutionRequest, controls: SandboxControls): Promise<Outcome<JsonValue>> {
    const parsed = sandboxExecutionRequestSchema.safeParse(raw);
    if (!parsed.success) return failure('INVALID_INPUT', 'Invalid sandbox request');
    if (controls.signal.aborted) return failure('CANCELLED', 'Execution cancelled');
    if (this.unhealthy) return failure('SANDBOX_UNAVAILABLE', 'Isolated runner unavailable');
    const request = parsed.data;
    const { limits } = request;
    if (Buffer.byteLength(JSON.stringify(request)) > limits.maxIpcFrameBytes) return limited('ipcFrameBytes');
    const name = `codebound-${randomUUID()}`;
    const deadline = Date.now() + limits.wallTimeMs;
    let created = false;
    let outcome: Outcome<JsonValue>;
    try {
      const os = await this.command(['info', '--format', '{{.OSType}}'], deadline - Date.now());
      if (os !== 'linux') throw new Error('Linux containers required');
      if (controls.signal.aborted || Date.now() >= deadline) throw new Error('Execution stopped');
      await this.command([
        'create', '--name', name, '--label', 'codebound.sandbox=true', '--interactive', '--network', 'none',
        '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges=true', '--pids-limit', String(limits.maxProcesses),
        '--cpus', String(limits.cpuCores), '--memory', String(limits.memoryBytes),
        '--memory-swap', String(limits.memoryBytes), '--ulimit', 'nofile=64:64',
        '--ulimit', 'core=0:0', '--ipc', 'none',
        '--log-driver', 'none', '--pull', 'never',
        ...emptyProxyEnvironment,
        this.options.image ?? 'codebound-sandbox:mvp',
      ], deadline - Date.now());
      created = true;
      if (controls.signal.aborted || Date.now() >= deadline) throw new Error('Execution stopped');
      outcome = await this.attach(name, request, controls, deadline);
    } catch {
      outcome = controls.signal.aborted
        ? failure('CANCELLED', 'Execution cancelled')
        : Date.now() >= deadline ? limited('wallTime')
          : failure('SANDBOX_UNAVAILABLE', 'Isolated runner unavailable');
    } finally {
      // Also attempt removal after a timed-out create: the daemon may have created it.
      try {
        await this.command(['rm', '--force', name], 5000);
      } catch {
        let absent = false;
        try {
          const names = await this.command(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], 5000);
          absent = names === '';
        } catch { /* Cannot establish cleanup: fail closed below. */ }
        if (!absent) {
          this.unhealthy = true;
          this.logger.error('Sandbox cleanup could not be confirmed; runner disabled');
        }
      }
    }
    if (this.unhealthy) return failure('SANDBOX_UNAVAILABLE', 'Sandbox cleanup could not be confirmed');
    // Missing image/daemon is unavailable, never a fallback to in-process eval.
    if (!created && outcome.ok) return failure('SANDBOX_UNAVAILABLE', 'Isolated runner unavailable');
    return outcome;
  }

  private attach(
    name: string, request: SandboxExecutionRequest, controls: SandboxControls, deadline: number,
  ): Promise<Outcome<JsonValue>> {
    const { limits } = request;
    return new Promise((resolve) => {
      const child = spawn(this.options.dockerBinary ?? 'docker', ['start', '--attach', '--interactive', name], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
      let settled = false;
      let ready = false;
      let buffer = Buffer.alloc(0);
      let calls = 0;
      let waiting = false;
      const requestIds = new Set<string>();
      let responseBytes = 0;
      let logBytes = 0;
      let result: Outcome<JsonValue> | undefined;
      const finish = (value: Outcome<JsonValue>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controls.signal.removeEventListener('abort', abort);
        child.stdin.destroy();
        child.kill();
        resolve(value);
      };
      const abort = () => finish(failure('CANCELLED', 'Execution cancelled'));
      const timer = setTimeout(() => finish(limited('wallTime')), Math.max(1, deadline - Date.now()));
      controls.signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(failure('SANDBOX_UNAVAILABLE', 'Isolated runner unavailable')));
      child.stdin.on('error', () => { /* Process close/timeout decides outcome. */ });
      child.stderr.on('data', (chunk: Buffer) => {
        // Discard contents completely: script errors/logs must not echo data.
        logBytes += chunk.length;
        if (logBytes > limits.maxLogBytes) finish(limited('logBytes'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        // Never concatenate an unbounded chunk before checking the frame cap.
        let offset = 0;
        while (offset < chunk.length && !settled) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.subarray(offset, end);
          if (buffer.length + part.length > limits.maxIpcFrameBytes) { finish(limited('ipcFrameBytes')); return; }
          buffer = Buffer.concat([buffer, part]);
          offset = end + 1;
          if (newline < 0) break;
          const frame = buffer;
          buffer = Buffer.alloc(0);
          handleFrame(frame);
        }
      });
      const handleFrame = (frame: Buffer) => {
        let message: unknown;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
        catch { finish(failure('SCRIPT_ERROR', 'Invalid sandbox protocol')); return; }
        if (!ready && z.strictObject({ type: z.literal('ready') }).safeParse(message).success) {
          ready = true;
          return;
        }
        if (!ready) { finish(failure('SANDBOX_UNAVAILABLE', 'Isolated runner unavailable')); return; }
        if (result) { finish(failure('SCRIPT_ERROR', 'Unexpected sandbox message')); return; }
        const call = sandboxConnectorCallSchema.safeParse(message);
        if (call.success) {
          if (waiting || requestIds.has(call.data.requestId)) { finish(limited('connectorCalls')); return; }
          if (++calls > limits.maxConnectorCalls) { finish(limited('connectorCalls')); return; }
          requestIds.add(call.data.requestId);
          if (Buffer.byteLength(JSON.stringify(call.data.arguments)) > limits.maxInputBytes) {
            finish(limited('inputBytes')); return;
          }
          waiting = true;
          // Do not allow callback completion to revive an expired execution.
          void Promise.resolve().then(() => settled ? undefined : controls.onConnectorCall(call.data)).then((rawReply) => {
            if (settled) return;
            const reply = supervisorConnectorReplySchema.safeParse(rawReply);
            if (!reply.success || reply.data.requestId !== call.data.requestId) {
              finish(failure('CONNECTOR_ERROR', 'Invalid connector reply')); return;
            }
            if (!reply.data.ok && !reply.data.recoverable) { finish({ ok: false, error: reply.data.error }); return; }
            const serialized = JSON.stringify(reply.data);
            const size = reply.data.ok ? Buffer.byteLength(JSON.stringify(reply.data.value)) : 0;
            responseBytes += size;
            if (size > limits.maxConnectorResponseBytes || responseBytes > limits.maxTotalConnectorResponseBytes) {
              finish(limited('connectorResponseBytes')); return;
            }
            if (Buffer.byteLength(serialized) > limits.maxIpcFrameBytes) { finish(limited('ipcFrameBytes')); return; }
            waiting = false;
            child.stdin.write(serialized + '\n');
          }).catch(() => finish(failure('CONNECTOR_ERROR', 'Connector operation failed')));
          return;
        }
        const output = resultFrame.safeParse(message);
        if (output.success && !waiting) {
          result = Buffer.byteLength(JSON.stringify(output.data.output)) > limits.maxOutputBytes
            ? limited('outputBytes') : { ok: true, value: output.data.output };
          return;
        }
        const error = errorFrame.safeParse(message);
        if (error.success) {
          finish(error.data.code === 'RESOURCE_LIMIT' ? limited(error.data.limit)
            : failure(error.data.code, 'Script execution failed'));
          return;
        }
        finish(failure('INVALID_OUTPUT', 'Invalid sandbox output'));
      };
      child.on('spawn', () => {
        if (settled) return;
        if (controls.signal.aborted) { abort(); return; }
        if (Date.now() >= deadline) { finish(limited('wallTime')); return; }
        child.stdin.write(JSON.stringify(request) + '\n');
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code === 0 && result && buffer.length === 0) { finish(result); return; }
        void this.command(['inspect', '--format', '{{.State.OOMKilled}}', name], 1000).then((oom) => {
          finish(oom === 'true' ? limited('memory') : failure(ready ? 'SCRIPT_ERROR' : 'SANDBOX_UNAVAILABLE', 'Isolated execution failed'));
        }).catch(() => finish(failure('SANDBOX_UNAVAILABLE', 'Isolated execution failed')));
      });
    });
  }
}
