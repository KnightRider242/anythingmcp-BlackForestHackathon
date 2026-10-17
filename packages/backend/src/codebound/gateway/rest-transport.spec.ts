// SPDX-License-Identifier: AGPL-3.0-only
import * as dns from 'node:dns';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BoundRestExecutor, ConnectorResponseLimitError } from './bound-rest-executor.service';
import type { BoundReadTool } from './bound-read-authorization.service';
import type { ConnectorCallControls, ExecutionPrincipal } from '../contracts';
import { SsrfBlockedError } from '../../common/ssrf.util';

const principal: ExecutionPrincipal = {
  userId: 'owner', organizationId: 'org-a', tokenIssuedAtMs: 1,
  tokenExpiresAtMs: Number.MAX_SAFE_INTEGER, origin: { kind: 'dashboard' },
};
const controls = (): ConnectorCallControls => ({
  signal: new AbortController().signal, deadlineEpochMs: Date.now() + 2000,
  maxResponseBytes: 1024, cache: 'bypass',
});
const tool = (baseUrl: string): BoundReadTool => ({
  useProxy: false, parameters: {}, endpointMapping: { method: 'GET', path: '/read' },
  connector: { type: 'REST', baseUrl, authType: 'NONE', envVars: {}, headers: {} },
} as unknown as BoundReadTool);

describe('CODEBOUND real outbound transport (no outboundRequest mock)', () => {
  const keys = ['SSRF_GUARD', 'SSRF_ALLOW_LOCALHOST', 'SSRF_ALLOW_PRIVATE', 'SSRF_ALLOWED_HOSTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  let saved: Record<string, string | undefined>;
  const executor = new BoundRestExecutor({ getDecryptedAuthConfig: () => ({}) } as any);
  const servers: https.Server[] = [];
  // Public test key, trusted ONLY by test-created agents. Never used by the app.
  const cert = readFileSync(join(__dirname, 'fixtures', 'localhost.cert.pem'));
  const key = readFileSync(join(__dirname, 'fixtures', 'localhost.key.pem'));
  const RealAgent = https.Agent;
  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = https.createServer({ key, cert }, handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';
    // Real agents, sockets, TLS verification and HTTP. Add just the fixture CA.
    jest.spyOn(https, 'Agent').mockImplementation(options => new RealAgent({ ...options, ca: cert }));
    return `https://localhost:${(server.address() as AddressInfo).port}`;
  }
  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    keys.forEach(key => { delete process.env[key]; });
    process.env.SSRF_GUARD = 'enabled';
  });
  afterEach(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'])('does not inherit the %s host DNS exemption when proxy use is disabled', async proxy => {
    process.env[proxy] = 'http://rebind.test:3128';
    const lookup = jest.spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as any)
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(executor.execute(tool('https://rebind.test:1'), {}, principal, controls()))
      .rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]'])('blocks private destination %s', async host => {
    await expect(executor.execute(tool(`https://${host}`), {}, principal, controls()))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('executes one real HTTPS GET with credentials and returns bounded JSON', async () => {
    const hits: { method?: string; url?: string; authorization?: string }[] = [];
    const base = await serve((req, res) => {
      hits.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json'); res.end('{"count":2}');
    });
    const row = tool(base); row.connector.headers = { Authorization: 'Bearer tls-test-canary' };
    row.endpointMapping = { method: 'GET', path: '/read', queryParams: { limit: 2 } };
    await expect(executor.execute(row, {}, principal, controls())).resolves.toEqual({ count: 2 });
    expect(hits).toEqual([{ method: 'GET', url: '/read?limit=2', authorization: 'Bearer tls-test-canary' }]);
  });

  it('does not follow a real HTTPS redirect or forward its credentials', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits++; res.writeHead(302, { Location: `${base}/credential-target` }); res.end('{}');
    });
    const row = tool(base); row.connector.headers = { Authorization: 'Bearer tls-test-canary' };
    await expect(executor.execute(row, {}, principal, controls())).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it('rejects a credential echoed by the real HTTPS server without its Bearer prefix', async () => {
    const base = await serve((req, res) => res.end(JSON.stringify({ echoed: req.headers.authorization?.slice(7) })));
    const row = tool(base); row.connector.headers = { Authorization: 'Bearer tls-test-canary' };
    await expect(executor.execute(row, {}, principal, controls())).rejects.toThrow('Credential echo');
  });

  it('keeps TLS certificate verification enabled', async () => {
    const base = await serve((_req, res) => res.end('{}'));
    jest.restoreAllMocks(); // Remove fixture-only CA trust, keep the real request path.
    await expect(executor.execute(tool(base), {}, principal, controls())).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it.each(['identity', 'gzip'])('caps a real chunked %s response after decompression', async encoding => {
    const base = await serve((_req, res) => {
      if (encoding === 'gzip') res.setHeader('Content-Encoding', 'gzip');
      const json = JSON.stringify({ text: 'x'.repeat(8192) });
      res.write(encoding === 'gzip' ? gzipSync(json) : json); res.end();
    });
    await expect(executor.execute(tool(base), {}, principal, controls())).rejects.toBeInstanceOf(ConnectorResponseLimitError);
  });

  it.each(['{"broken":', '{"__proto__":{"polluted":true}}', '{"value":1e999}'])('rejects invalid/unsafe JSON %s from real HTTPS', async body => {
    const base = await serve((_req, res) => res.end(body));
    await expect(executor.execute(tool(base), {}, principal, controls())).rejects.toThrow();
  });

  it('cancels before HTTP dispatch when a preflight DNS operation finishes late', async () => {
    let release!: (value: any) => void; let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    jest.spyOn(dns.promises, 'lookup').mockImplementation(() => {
      started(); return new Promise(resolve => { release = resolve; });
    });
    const request = jest.spyOn(https, 'request');
    const controller = new AbortController();
    const result = executor.execute(tool('https://cancel.test'), {}, principal, { ...controls(), signal: controller.signal });
    await began; controller.abort(); release([{ address: '93.184.216.34', family: 4 }]);
    await expect(result).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts and closes a real active TLS request', async () => {
    let started!: () => void; let disconnected!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const base = await serve((req, _res) => { req.on('close', disconnected); started(); });
    const controller = new AbortController();
    const result = executor.execute(tool(base), {}, principal, { ...controls(), signal: controller.signal });
    await began; controller.abort();
    await expect(result).rejects.toThrow();
    await closed;
  });
});
