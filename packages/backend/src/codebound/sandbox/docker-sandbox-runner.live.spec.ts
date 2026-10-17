// SPDX-License-Identifier: AGPL-3.0-only
import { DockerSandboxRunner } from './docker-sandbox-runner';
import { MVP_LIMITS } from '../contracts';
import type { SandboxExecutionRequest } from '../contracts';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
const containers = () => docker('ps', '--all', '--filter', 'label=codebound.sandbox=true', '--format', '{{.ID}}');

const live = process.env.RUN_CODEBOUND_SANDBOX_LIVE === '1' ? describe : describe.skip;
live('DockerSandboxRunner — real disposable container', () => {
  let baseline: string;
  beforeAll(() => {
    // Fail if Jest config or another test accidentally replaces real processes.
    expect(jest.isMockFunction(execFileSync)).toBe(false);
    const { spawn, execFile } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const loaded = require('node:child_process');
    expect(loaded.spawn).toBe(spawn);
    expect(loaded.execFile).toBe(execFile);
    expect(jest.isMockFunction(loaded.spawn)).toBe(false);
    expect(jest.isMockFunction(loaded.execFile)).toBe(false);
    expect(docker('info', '--format', '{{.OSType}}')).toBe('linux');
  });
  beforeEach(() => { baseline = containers(); });
  afterEach(() => { expect(containers()).toBe(baseline); });
  const execute = (source: string, limits: Partial<SandboxExecutionRequest['limits']> = {}) =>
    new DockerSandboxRunner().execute({
      executionId: 'security-test', source, input: {}, limits: { ...MVP_LIMITS, ...limits },
    }, { signal: new AbortController().signal, onConnectorCall: jest.fn() });

  it('executes async main inside the container and returns bounded JSON', async () => {
    const runner = new DockerSandboxRunner();
    const result = await runner.execute({
      executionId: 'first-container-test',
      source: 'async function main(input, api) { return { answer: input.value + 1 }; }',
      input: { value: 41 }, limits: MVP_LIMITS,
    }, { signal: new AbortController().signal, onConnectorCall: jest.fn() });
    expect(result).toEqual({ ok: true, value: { answer: 42 } });
  }, 30_000);

  it('uses bounded api.read IPC with a fake gateway and inspects actual isolation', async () => {
    const onConnectorCall = jest.fn(async (call) => {
      const ids = containers().split('\n').filter((id) => !baseline.split('\n').includes(id));
      expect(ids).toHaveLength(1);
      const [inspection] = JSON.parse(docker('inspect', ids[0]));
      expect(inspection.Config.User).toBe('65534:65534');
      expect(inspection.HostConfig).toMatchObject({
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], PidsLimit: 16,
        Memory: MVP_LIMITS.memoryBytes, MemorySwap: MVP_LIMITS.memoryBytes,
        NanoCpus: 500_000_000, LogConfig: { Type: 'none' },
      });
      expect(inspection.HostConfig.SecurityOpt).toContain('no-new-privileges=true');
      expect(inspection.Mounts).toEqual([]);
      expect(call.arguments).toEqual({ filter: 'open' });
      return { type: 'connector.reply' as const, requestId: call.requestId, ok: true as const, value: [{ priority: 1 }, { priority: 2 }] };
    });
    expect(await new DockerSandboxRunner().execute({
      executionId: 'fake-gateway', input: {}, limits: MVP_LIMITS,
      source: 'async function main(input, api) { const tasks = await api.read({filter:"open"}); return {count: tasks.length}; }',
    }, { signal: new AbortController().signal, onConnectorCall })).toEqual({ ok: true, value: { count: 2 } });
    expect(onConnectorCall).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('rejects a second call even when the script catches errors', async () => {
    const onConnectorCall = jest.fn(async (call) => ({ type: 'connector.reply' as const, requestId: call.requestId, ok: true as const, value: [] }));
    const result = await new DockerSandboxRunner().execute({
      executionId: 'second-read', input: {}, limits: MVP_LIMITS,
      source: 'async function main(input, api) { await api.read({}); try { await api.read({}); } catch {} return {}; }',
    }, { signal: new AbortController().signal, onConnectorCall });
    expect(result).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorCalls' } });
    expect(onConnectorCall).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('blocks external, metadata and loopback TCP access and direct DNS', async () => {
    const result = await execute(`async function main() {
      const net = process.getBuiltinModule('net');
      const blocked = await Promise.all(['1.1.1.1','169.254.169.254','127.0.0.1'].map(host =>
        new Promise(resolve => { const s = net.connect(80, host); s.setTimeout(500);
          s.on('connect', () => { s.destroy(); resolve(false); });
          s.on('error', () => resolve(true)); s.on('timeout', () => { s.destroy(); resolve(true); }); })));
      const Resolver = process.getBuiltinModule('dns').promises.Resolver;
      const dns = new Resolver({timeout:500,tries:1}); dns.setServers(['1.1.1.1']);
      let dnsBlocked = false; try { await dns.resolve4('example.com'); } catch { dnsBlocked = true; }
      return { blocked, dnsBlocked };
    }`);
    expect(result).toEqual({ ok: true, value: { blocked: [true, true, true], dnsBlocked: true } });
  }, 30_000);

  it('runs non-root without host files, inherited secrets or writable root', async () => {
    process.env.CODEBOUND_CANARY_SECRET = 'never-pass-to-container';
    try {
      const result = await execute(`async function main() {
        const fs = process.getBuiltinModule('fs'); let readOnly = false;
        try { fs.writeFileSync('/sandbox/host-write', 'x'); } catch { readOnly = true; }
        return {uid: process.getuid(), readOnly, socket: fs.existsSync('/var/run/docker.sock'),
          appEnv: fs.existsSync('/app/.env'), host: fs.existsSync('/host'),
          secretAbsent: process.env.CODEBOUND_CANARY_SECRET === undefined};
      }`);
      expect(result).toEqual({ ok: true, value: { uid: 65534, readOnly: true, socket: false, appEnv: false, host: false, secretAbsent: true } });
    } finally { delete process.env.CODEBOUND_CANARY_SECRET; }
  }, 30_000);

  it('does not expose proxy credentials from the supervisor Docker CLI configuration', async () => {
    const endpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
    const directory = mkdtempSync(join(tmpdir(), 'codebound-proxy-test-'));
    const previousConfig = process.env.DOCKER_CONFIG;
    const previousHost = process.env.DOCKER_HOST;
    try {
      writeFileSync(join(directory, 'config.json'), JSON.stringify({ proxies: { default: {
        httpProxy: 'http://dummy-user:proxy-canary@proxy.invalid:8080',
        httpsProxy: 'http://dummy-user:proxy-canary@proxy.invalid:8080',
        ftpProxy: 'http://dummy-user:proxy-canary@proxy.invalid:8080',
        allProxy: 'http://dummy-user:proxy-canary@proxy.invalid:8080',
        noProxy: 'private-host-canary.invalid',
      } } }));
      process.env.DOCKER_CONFIG = directory;
      process.env.DOCKER_HOST = endpoint;
      const result = await execute(`async function main() {
        return {empty: Object.entries(process.env).filter(([key]) => /proxy/i.test(key)).every(([,value]) => value === '')};
      }`);
      expect(result).toEqual({ ok: true, value: { empty: true } });
    } finally {
      if (previousConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = previousConfig;
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('kills an infinite loop externally and cleans up', async () => {
    expect(await execute('async function main() { while(true) {} }', { wallTimeMs: 3000 }))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'wallTime' } });
  }, 30_000);

  it('keeps the PID 1 deadline even when scripts stop helpers and the attach process disappears', async () => {
    const name = `codebound-watchdog-test-${randomUUID()}`;
    let attach: ReturnType<typeof spawn> | undefined;
    try {
      docker('create', '--name', name, '--label', 'codebound.sandbox=true', '--interactive',
        '--network', 'none', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges=true', '--pids-limit', '16', '--cpus', '0.5',
        '--memory', String(MVP_LIMITS.memoryBytes), '--memory-swap', String(MVP_LIMITS.memoryBytes),
        '--log-driver', 'none',
        ...['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
          'http_proxy', 'https_proxy', 'ftp_proxy', 'no_proxy', 'all_proxy'].flatMap(key => ['--env', `${key}=`]),
        'codebound-sandbox:mvp');
      attach = spawn('docker', ['start', '--attach', '--interactive', name], { windowsHide: true });
      const process_ = attach;
      const request = {
        executionId: 'watchdog-regression', input: {}, limits: MVP_LIMITS,
        source: `async function main(input, api) {
          const fs = process.getBuiltinModule('fs');
          for (const pid of fs.readdirSync('/proc').filter(p => /^[0-9]+$/.test(p) && p !== '1')) {
            try { if (fs.readFileSync('/proc/'+pid+'/cmdline','utf8').startsWith('timeout')) process.kill(Number(pid),'SIGSTOP'); } catch {}
          }
          process.kill(1, 'SIGSTOP');
          let protectedMemory = false;
          try { const fd = fs.openSync('/proc/1/mem','r+'); fs.closeSync(fd); } catch { protectedMemory = true; }
          void api.read({protectedMemory}); while (true) {}
        }`,
      };
      process_.stdin!.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        let frame = '';
        const timeout = setTimeout(() => reject(new Error('Container did not call fake gateway')), 5000);
        process_.on('error', reject);
        process_.stdout!.on('data', (chunk: Buffer) => {
          frame += chunk.toString();
          if (frame.length > 4096) { clearTimeout(timeout); reject(new Error('Unexpected test protocol')); return; }
          for (const line of frame.split('\n').slice(0, -1)) {
            const message = JSON.parse(line);
            if (message.type === 'connector.call') {
              clearTimeout(timeout);
              if (message.arguments.protectedMemory !== true) reject(new Error('Watchdog memory is writable'));
              else resolve();
            }
          }
        });
        process_.stdin!.write(JSON.stringify(request) + '\n');
      });
      process_.kill('SIGKILL');
      process_.stdin!.destroy();
      expect(docker('inspect', '--format', '{{.State.Running}}', name)).toBe('true');
      // No DockerSandboxRunner host timer exists in this test. PID 1 must stop it.
      const code = execFileSync('docker', ['wait', name], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim();
      expect(code).toBe('124');
    } finally {
      attach?.kill();
      docker('rm', '--force', name);
    }
  }, 30_000);

  it('enforces memory with an actual cgroup OOM kill', async () => {
    expect(await execute('async function main() { const a=[]; while(true) a.push(Buffer.alloc(8*1024*1024,1)); }'))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'memory' } });
  }, 30_000);

  it('prevents process exhaustion at the configured PID ceiling', async () => {
    const result = await execute(`async function main() {
      const spawn = process.getBuiltinModule('child_process').spawn;
      const denied = await Promise.all(Array.from({length:24}, () => new Promise(resolve => {
        const p = spawn('/bin/sleep',['2']); p.on('error', () => resolve(true));
        p.on('spawn', () => resolve(false));
      })));
      return {denied: denied.some(Boolean)};
    }`);
    expect(result).toEqual({ ok: true, value: { denied: true } });
  }, 30_000);

  it.each([
    ['outputBytes', 'async function main() { return "x".repeat(16384); }', {}],
    ['outputBytes', 'async function main() { return {value:1}; }', { maxOutputBytes: 2 }],
    ['logBytes', 'async function main() { process.stderr.write("x".repeat(5000)); return {}; }', {}],
    ['ipcFrameBytes', 'async function main() { process.stdout.write("x".repeat(700000)); await new Promise(()=>{}); }', {}],
  ])('enforces %s without returning script data', async (limit, source, limits) => {
    expect(await execute(source, limits)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit } });
  }, 30_000);

  it('rejects invalid JSON and sanitizes thrown errors', async () => {
    expect(await execute('async function main() { return {value: undefined}; }'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_OUTPUT' } });
    const result = await execute('async function main() { throw new Error("secret-canary"); }');
    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('secret-canary');
  }, 30_000);

  it('accepts exactly 16 KiB of serialized JSON output', async () => {
    const result = await execute('async function main() { return "x".repeat(16382); }');
    expect(result.ok).toBe(true);
    if (result.ok) expect(Buffer.byteLength(JSON.stringify(result.value))).toBe(16 * 1024);
  }, 30_000);

  it('cancels an active container and ignores a late gateway reply', async () => {
    const controller = new AbortController();
    let release!: (value: any) => void;
    const result = new DockerSandboxRunner().execute({
      executionId: 'cancelled', input: {}, limits: MVP_LIMITS,
      source: 'async function main(input, api) { return await api.read({}); }',
    }, {
      signal: controller.signal,
      onConnectorCall: () => {
        controller.abort();
        return new Promise(resolve => { release = resolve; });
      },
    });
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    release({ type: 'connector.reply', requestId: 'read-1', ok: true, value: [] });
  }, 30_000);

  it('fails closed when the configured image is unavailable', async () => {
    const result = await new DockerSandboxRunner({ image: 'codebound-deliberately-missing:fixture' }).execute({
      executionId: 'unavailable', source: 'async function main(){ return {}; }', input: {}, limits: MVP_LIMITS,
    }, { signal: new AbortController().signal, onConnectorCall: jest.fn() });
    expect(result).toMatchObject({ ok: false, error: { code: 'SANDBOX_UNAVAILABLE' } });
  }, 30_000);
});
