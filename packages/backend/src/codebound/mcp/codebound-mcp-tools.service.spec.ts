// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { AuthService } from '../../auth/auth.service';
import { parseScriptSnapshot } from '../contracts.validation';
import { CodeboundMcpToolsService, MCP_DISCOVERY_LIMITS, scriptToolName } from './codebound-mcp-tools.service';

describe('CODEBOUND MCP bridge (database and execution mocked)', () => {
  const jwt = new JwtService({ secret: 'codebound-mcp-public-unit-test-secret' });
  const source = 'async function main(input, api) { return await api.read({}); }';
  const snapshot = parseScriptSnapshot({ id: 'script-a', organizationId: 'org-a', ownerUserId: 'owner', revision: 1,
    source, sourceSha256: createHash('sha256').update(source).digest('hex'), name: 'Summary', description: 'Compact totals',
    binding: { connectorId: 'connector', toolId: 'tool', definitionSha256: 'a'.repeat(64) },
    inputSchema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'], additionalProperties: false }, outputSchema: {} });
  let service: CodeboundMcpToolsService; let persistence: any; let authorization: any; let execution: any; let keys: any;
  beforeEach(() => {
    persistence = { list: jest.fn().mockResolvedValue({ ok: true, value: [snapshot] }),
      get: jest.fn().mockResolvedValue({ ok: true, value: snapshot }) };
    authorization = { authorize: jest.fn().mockResolvedValue({}) };
    execution = { execute: jest.fn().mockResolvedValue({ ok: true, value: { status: 'succeeded', output: { total: 11 }, executionId: 'run', revision: 1 } }) };
    keys = { findFirst: jest.fn().mockResolvedValue({ userId: 'owner', organizationId: 'org-a',
      createdAt: new Date(Date.now() - 10_000) }) };
    service = new CodeboundMcpToolsService({ mcpServerConfig: { findFirst: async () => ({ organizationId: 'org-a' }) }, mcpApiKey: keys } as any,
      new AuthService(jwt), persistence, authorization, execution);
  });
  const request = (claims = {}, method = 'jwt') => Object.assign(new EventEmitter(), { user: { authMethod: method, sub: 'spoofed-user', organizationId: 'spoofed-org' },
    headers: { authorization: `Bearer ${jwt.sign({ sub: 'owner', organizationId: 'wrong-claim-org', type: 'access', azp: 'client-a', ...claims }, { expiresIn: '1h' })}` }, aborted: false });
  const keyRequest = (token = 'mcp_codebound-test-key') => Object.assign(new EventEmitter(), {
    user: { authMethod: 'mcp_api_key', sub: 'untrusted', organizationId: 'spoofed-org' },
    headers: { authorization: `Bearer ${token}` }, aborted: false,
  });
  const response = () => Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const within = <T>(fn: () => Promise<T>, req = request()) => service.withRequest(req as any, response() as any, 'server-a', fn);
  async function handler() {
    const entries = await service.entries(service.currentPrincipal());
    let callback: any;
    entries[0].register({ registerTool: (_name: string, _config: unknown, fn: any) => { callback = fn; return { remove() {} }; } } as any);
    return callback;
  }
  const context = () => ({ mcpReq: { signal: new AbortController().signal } });

  it('uses verified JWT user and live server organization, never req.user identities', async () => {
    await within(async () => {
      expect(service.currentPrincipal()).toMatchObject({ userId: 'owner', organizationId: 'org-a', origin: { kind: 'mcp', serverId: 'server-a', oauthClientId: 'client-a' } });
      const invoke = await handler();
      expect(await invoke({ category: 'sales', userId: 'attacker', organizationId: 'org-b' }, context())).toMatchObject({ content: [{ text: '{"total":11}' }] });
      expect(execution.execute.mock.calls[0][0].userId).toBe('owner');
      expect(execution.execute.mock.calls[0][1]).toMatchObject({ scriptId: snapshot.id, expectedRevision: 1 });
    });
  });
  it.each(['none', 'static_bearer', 'static_api_key', 'mcp_api_key'])('does not expose scripts for %s authentication', async method => {
    await within(async () => { expect(await service.entries(service.currentPrincipal())).toEqual([]); }, request({}, method));
    expect(persistence.list).not.toHaveBeenCalled();
  });
  it.each(['refresh', 'user'])('rejects a signed %s token', async type => {
    await within(async () => { expect(service.currentPrincipal()).toBeUndefined(); }, request({ type }));
  });
  it('fails closed for forged JWTs', async () => {
    const req = request(); req.headers.authorization += 'tampered';
    await within(async () => { expect(service.currentPrincipal()).toBeUndefined(); }, req);
  });
  it('re-verifies a server-pinned MCP API key and uses only the live credential owner', async () => {
    await within(async () => {
      expect(service.currentPrincipal()).toMatchObject({
        userId: 'owner', organizationId: 'org-a',
        origin: { kind: 'mcp', serverId: 'server-a', oauthClientId: null },
      });
      const invoke = await handler();
      expect(await invoke({ category: 'sales' }, context())).toMatchObject({
        content: [{ text: '{"total":11}' }],
      });
      expect(execution.execute.mock.calls[0][0].userId).toBe('owner');
    }, keyRequest());
    expect(keys.findFirst).toHaveBeenCalledWith({
      where: { key: 'mcp_codebound-test-key', isActive: true, mcpServerId: 'server-a' },
      select: { id: true, userId: true, organizationId: true, createdAt: true },
    });
  });
  it('denies revoked, missing and unscoped API keys even when req.user claims authority', async () => {
    for (const token of ['mcp_revoked', 'mcp_unscoped']) {
      keys.findFirst.mockResolvedValueOnce(null);
      await within(async () => {
        expect(service.currentPrincipal()).toBeUndefined();
        expect(await service.entries(service.currentPrincipal())).toEqual([]);
      }, keyRequest(token));
    }
    expect(persistence.list).not.toHaveBeenCalled();
  });
  it('publishes all F1 suffixes and typed schemas for a verified server-scoped API key', async () => {
    const fixtures = [
      { name: 'price_drift_check', properties: { threshold: { type: 'number' } } },
      { name: 'catalogue_total', properties: { category: { type: 'string' } } },
      { name: 'stuck_orders', properties: { days: { type: 'number' }, as_of: { type: 'string' } } },
    ];
    persistence.list.mockResolvedValue({ ok: true, value: fixtures.map(fixture => ({
      ...snapshot, id: fixture.name, name: fixture.name,
      inputSchema: { type: 'object', properties: fixture.properties,
        required: Object.keys(fixture.properties), additionalProperties: false },
    })) });
    await within(async () => {
      const entries = await service.entries(service.currentPrincipal());
      expect(entries).toHaveLength(3);
      entries.forEach((entry, index) => {
        const fixture = fixtures[index];
        expect(entry.name.endsWith('_' + fixture.name)).toBe(true);
        const registerTool = jest.fn(() => ({ remove() {} }));
        entry.register({ registerTool } as any);
        const [, config] = registerTool.mock.calls[0] as unknown as [string, { inputSchema: z.ZodObject }];
        expect(z.toJSONSchema(config.inputSchema)).toMatchObject({
          type: 'object', properties: fixture.properties,
          required: Object.keys(fixture.properties), additionalProperties: false,
        });
      });
    }, keyRequest());
    expect(authorization.authorize).toHaveBeenCalledTimes(3);
  });
  it('denies keys from a server without live membership', async () => {
    (service as any).prisma.mcpServerConfig.findFirst = jest.fn().mockResolvedValue(null);
    await within(async () => expect(service.currentPrincipal()).toBeUndefined(), keyRequest());
  });
  it('returns human-readable, collision-resistant, bounded MCP script names', () => {
    const first = scriptToolName('script-a', 'price_drift_check');
    const second = scriptToolName('script-b', 'price_drift_check');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^codebound_script_[a-f0-9]{12}_price_drift_check$/);
    expect(scriptToolName('script-a', 'x'.repeat(500)).length).toBeLessThanOrEqual(64);
    expect(scriptToolName('script-a', '../__proto__/')).toMatch(/^codebound_script_[a-f0-9]{12}_proto$/);
  });
  it('generates stable bounded names and registers only public metadata/schema', async () => {
    expect(scriptToolName('script-a')).toBe(scriptToolName('script-a'));
    expect(scriptToolName('script-a')).not.toBe(scriptToolName('script-b'));
    expect(scriptToolName('script-a').length).toBeLessThanOrEqual(64);
    await within(async () => {
      const entries = await service.entries(service.currentPrincipal()); const registerTool = jest.fn(() => ({ remove() {} }));
      entries[0].register({ registerTool } as any);
      const config = registerTool.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(JSON.stringify(config)).not.toContain(source); expect(JSON.stringify(config)).not.toContain('definitionSha256');
      expect((config[1].inputSchema as any).safeParse({ category: 'a', userId: 'spoof' }).success).toBe(false);
    });
  });
  it('does not list scripts with denied live authorization', async () => {
    authorization.authorize.mockRejectedValue(new Error('credential-canary'));
    await within(async () => { expect(await service.entries(service.currentPrincipal())).toEqual([]); });
  });
  it.each(['deleted', 'revision', 'binding'])('rejects a stale %s registration before execution', async reason => {
    await within(async () => {
      const invoke = await handler();
      if (reason === 'deleted') persistence.get.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND' } });
      if (reason === 'revision') persistence.get.mockResolvedValue({ ok: true, value: { ...snapshot, revision: 2 } });
      if (reason === 'binding') authorization.authorize.mockRejectedValue(new Error('credential-canary'));
      const result = await invoke({ category: 'a' }, context()); expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('credential-canary'); expect(execution.execute).not.toHaveBeenCalled();
    });
  });
  it('does not retain a prior request principal in a stored handler', async () => {
    const invoke = await within(handler);
    expect((await invoke({ category: 'a' }, context())).isError).toBe(true);
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it('uses a renewed request token instead of the registration token', async () => {
    const invoke = await within(handler);
    const issuedAt = Math.floor(Date.now() / 1000) - 5;
    await within(async () => { await invoke({ category: 'a' }, context()); }, request({ iat: issuedAt }));
    expect(execution.execute.mock.calls[0][0].tokenIssuedAtMs).toBe(issuedAt * 1000);
  });
  it('propagates disconnect and SDK cancellation to the existing orchestrator', async () => {
    await within(async () => {
      const invoke = await handler(); const cancelled = AbortSignal.abort();
      await invoke({ category: 'a' }, { mcpReq: { signal: cancelled } });
      expect(execution.execute.mock.calls[0][2].aborted).toBe(true);
    });
  });
  it('sanitizes thrown execution errors', async () => {
    execution.execute.mockRejectedValue(new Error('credential-canary'));
    await within(async () => { const invoke = await handler(); expect(await invoke({ category: 'a' }, context())).toMatchObject({ isError: true }); });
  });

  it('bounds script candidates before authorization and drops oversized tool metadata', async () => {
    persistence.list.mockResolvedValue({ ok: true, value: Array.from({ length: 100 }, (_, i) => ({ ...snapshot, id: `script-${i}` })) });
    await within(async () => {
      expect(await service.entries(service.currentPrincipal())).toHaveLength(MCP_DISCOVERY_LIMITS.scripts);
      expect(persistence.list).toHaveBeenCalledWith(service.currentPrincipal(), { limit: MCP_DISCOVERY_LIMITS.scripts });
    });
    expect(authorization.authorize).toHaveBeenCalledTimes(MCP_DISCOVERY_LIMITS.scripts);
    persistence.list.mockResolvedValue({ ok: true, value: Array.from({ length: 32 }, (_, i) => ({ ...snapshot, id: `script-${i}`,
      inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'x'.repeat(15000) } } } })) });
    await within(async () => {
      const entries = await service.entries(service.currentPrincipal());
      expect(entries.length).toBeGreaterThan(0); expect(entries.length).toBeLessThan(5);
    });
  });

  it('keeps admission slots occupied by timed-out DB work until it settles', async () => {
    const controller = new AbortController(); const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let release!: (value: unknown) => void;
    persistence.list.mockReturnValue(new Promise(resolve => { release = resolve; }));
    try {
      await within(async () => {
        const p = service.currentPrincipal(); const first = service.entries(p); const second = service.entries(p);
        controller.abort(); expect(await first).toEqual([]); expect(await second).toEqual([]);
        expect(await service.entries(p)).toEqual([]); expect(persistence.list).toHaveBeenCalledTimes(2);
        release({ ok: true, value: [] });
        await new Promise(resolve => setImmediate(resolve));
        expect(authorization.authorize).not.toHaveBeenCalled();
      });
    } finally { timeout.mockRestore(); }
  });

  it('bounds discovery across organizations without an unbounded waiting queue', async () => {
    let release!: (value: unknown) => void;
    persistence.list.mockReturnValue(new Promise(resolve => { release = resolve; }));
    await within(async () => {
      const p = service.currentPrincipal()!;
      const work = ['org-a', 'org-a', 'org-b', 'org-b'].map(organizationId => service.entries({ ...p, organizationId }));
      expect(await service.entries({ ...p, organizationId: 'org-c' })).toEqual([]);
      expect(persistence.list).toHaveBeenCalledTimes(MCP_DISCOVERY_LIMITS.concurrent);
      release({ ok: true, value: [] }); await Promise.all(work);
    });
  });
});
