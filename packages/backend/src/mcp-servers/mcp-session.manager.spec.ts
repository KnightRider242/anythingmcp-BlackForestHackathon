import { McpSessionManager, McpSessionEntry } from './mcp-session.manager';

/**
 * Unit coverage for the stateful MCP session lifecycle: cap eviction, close,
 * and broad rebuild fan-out. Transport/server are stubbed.
 */
describe('McpSessionManager', () => {
  const makeEntry = (id: string, over: Partial<McpSessionEntry> = {}): McpSessionEntry => ({
    sessionId: id,
    serverId: 'srv',
    organizationId: 'org',
    principalKey: 'sub:u',
    transport: { close: jest.fn().mockResolvedValue(undefined) } as any,
    mcpServer: { close: jest.fn().mockResolvedValue(undefined) } as any,
    handles: new Map(),
    signature: '',
    rebuild: jest.fn().mockResolvedValue(undefined),
    lastActivity: Date.now(),
    ...over,
  });

  afterEach(() => {
    delete process.env.MCP_STATEFUL_SESSIONS;
    delete process.env.MCP_MAX_SESSIONS;
  });

  it('isEnabled reflects the env flag', () => {
    expect(McpSessionManager.isEnabled()).toBe(false);
    process.env.MCP_STATEFUL_SESSIONS = 'true';
    expect(McpSessionManager.isEnabled()).toBe(true);
  });

  it('stores and retrieves a session, and touch updates activity', () => {
    const mgr = new McpSessionManager();
    const e = makeEntry('a', { lastActivity: 1 });
    mgr.add(e);
    expect(mgr.get('a')).toBe(e);
    mgr.touch('a', 999);
    expect(mgr.get('a')!.lastActivity).toBe(999);
  });

  it('remove() closes the transport and server and forgets the session', async () => {
    const mgr = new McpSessionManager();
    const e = makeEntry('a');
    mgr.add(e);
    await mgr.remove('a');
    expect(e.transport.close).toHaveBeenCalled();
    expect(e.mcpServer.close).toHaveBeenCalled();
    expect(mgr.get('a')).toBeUndefined();
    await expect(mgr.remove('a')).resolves.toBeUndefined(); // idempotent
  });

  it('evicts the least-recently-active session when the cap is reached', () => {
    process.env.MCP_MAX_SESSIONS = '2';
    const mgr = new McpSessionManager();
    const old = makeEntry('old', { lastActivity: 1 });
    const mid = makeEntry('mid', { lastActivity: 5 });
    mgr.add(old);
    mgr.add(mid);
    mgr.add(makeEntry('new', { lastActivity: 9 })); // triggers eviction
    expect(mgr.get('old')).toBeUndefined(); // oldest evicted
    expect(mgr.get('mid')).toBeDefined();
    expect(mgr.get('new')).toBeDefined();
  });

  it('notifyToolsChanged() invokes rebuild on every session and survives a failure', async () => {
    const mgr = new McpSessionManager();
    const good = makeEntry('good');
    const bad = makeEntry('bad', {
      rebuild: jest.fn().mockRejectedValue(new Error('boom')),
    });
    mgr.add(good);
    mgr.add(bad);
    await expect(mgr.notifyToolsChanged()).resolves.toBeUndefined();
    expect(good.rebuild).toHaveBeenCalled();
    expect(bad.rebuild).toHaveBeenCalled();
  });

  it('scopes CODEBOUND lifecycle refresh to the affected organization and owner', async () => {
    const mgr = new McpSessionManager();
    const principal = { userId: 'owner', organizationId: 'org-a', tokenIssuedAtMs: 1, tokenExpiresAtMs: 100,
      origin: { kind: 'mcp' as const, serverId: 'srv', oauthClientId: null } };
    const own = makeEntry('own', { codeboundPrincipal: principal });
    const foreign = makeEntry('foreign', { codeboundPrincipal: { ...principal, organizationId: 'org-b' } });
    const other = makeEntry('other', { codeboundPrincipal: { ...principal, userId: 'other' } });
    const legacy = makeEntry('legacy');
    for (const entry of [own, foreign, other, legacy]) mgr.add(entry);
    await mgr.notifyToolsChanged({ organizationId: 'org-a', ownerUserId: 'owner' });
    expect(own.rebuild).toHaveBeenCalledTimes(1);
    for (const entry of [foreign, other, legacy]) expect(entry.rebuild).not.toHaveBeenCalled();
    await mgr.onModuleDestroy();
  });
});
