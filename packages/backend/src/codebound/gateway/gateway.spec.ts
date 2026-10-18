// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { AxiosError } from 'axios';
import { BoundReadAuthorization, fingerprintReadTool } from './bound-read-authorization.service';
import type { BoundReadTool } from './bound-read-authorization.service';
import { BoundRestExecutor, allowsCodeboundTestHttp } from './bound-rest-executor.service';
import { AuthorizedConnectorGatewayService } from './authorized-connector-gateway.service';
import { parseScriptSnapshot } from '../contracts.validation';
import { MVP_LIMITS } from '../contracts';
import type { ExecutionPrincipal, ConnectorCallControls, GatewaySession } from '../contracts';
import { outboundRequest } from '../../common/outbound-http';

jest.mock('../../common/outbound-http', () => ({
  ...jest.requireActual('../../common/outbound-http'), outboundRequest: jest.fn(),
}));
const http = outboundRequest as jest.MockedFunction<typeof outboundRequest>;
const principal = (): ExecutionPrincipal => ({
  userId: 'owner', organizationId: 'org-a', tokenIssuedAtMs: Date.now() - 1000,
  tokenExpiresAtMs: Date.now() + 60_000, origin: { kind: 'dashboard' },
});
const tool = (): BoundReadTool => ({
  id: 'tool-a', connectorId: 'connector-a', name: 'todoist_read', isEnabled: true,
  useProxy: false, parameters: { type: 'object', properties: { filter: { type: 'string' }, id: { type: 'string' } } },
  endpointMapping: { method: 'GET', path: '/tasks', queryParams: { filter: '$filter' } },
  responseMapping: { cacheTtl: 60 }, outputSchema: null,
  connector: {
    id: 'connector-a', organizationId: 'org-a', userId: 'owner', isActive: true,
    type: 'REST', baseUrl: 'https://api.example.com/v1', authType: 'BEARER_TOKEN',
    authConfig: 'encrypted-fixture', envVars: { TOKEN: 'credential-canary-12345' }, headers: {}, config: {},
  },
} as unknown as BoundReadTool);
const script = (definition = tool()) => {
  const source = 'async function main(input, api) { return await api.read({}); }';
  return parseScriptSnapshot({
    id: 'script-a', organizationId: 'org-a', ownerUserId: 'owner', revision: 1,
    name: 'Read tasks', description: '', source,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    inputSchema: {}, outputSchema: {},
    binding: { connectorId: definition.connectorId, toolId: definition.id, definitionSha256: fingerprintReadTool(definition) },
  });
};
const controls = (): ConnectorCallControls => ({
  signal: new AbortController().signal, deadlineEpochMs: Date.now() + 9000,
  maxResponseBytes: MVP_LIMITS.maxConnectorResponseBytes, cache: 'bypass',
});
const call = () => ({ type: 'connector.call' as const, requestId: 'request-a', binding: 'connector.read' as const, arguments: { filter: 'open' } });

function setup() {
  const row = tool();
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'owner', sessionsValidFrom: null }) },
    mcpTool: { findFirst: jest.fn().mockResolvedValue(row) },
    mcpServerConfig: { findFirst: jest.fn().mockResolvedValue({ id: 'server-a' }) },
  };
  const roles = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
  const grants = { resolve: jest.fn().mockResolvedValue(null) };
  const license = { checkLicenseActive: jest.fn().mockResolvedValue(undefined) };
  const authorization = new BoundReadAuthorization(prisma as any, roles as any, grants as any, license as any);
  const connectors = { getDecryptedAuthConfig: jest.fn().mockReturnValue({ token: '{{TOKEN}}' }) };
  const executor = new BoundRestExecutor(connectors as any);
  const gateway = new AuthorizedConnectorGatewayService(authorization, executor);
  return { row, prisma, roles, grants, license, authorization, connectors, executor, gateway };
}

beforeEach(() => {
  jest.clearAllMocks();
  http.mockResolvedValue({ data: { tasks: [{ priority: 1 }] } } as any);
});

describe('CODEBOUND live authorization checks (database mocked)', () => {
  it('checks exact organization/owner filters and preserves null vs [] role semantics', async () => {
    const s = setup();
    await expect(s.authorization.authorize(principal(), script())).resolves.toMatchObject({ id: 'tool-a' });
    expect(s.prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'owner', memberships: { some: { organizationId: 'org-a', deactivatedAt: null } },
    } }));
    expect(s.prisma.mcpTool.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'tool-a', connectorId: 'connector-a', isEnabled: true,
      connector: { organizationId: 'org-a', userId: 'owner', isActive: true },
    } }));
    s.roles.getAllowedToolIds.mockResolvedValue([]);
    await expect(s.authorization.authorize(principal(), script())).rejects.toThrow();
    s.roles.getAllowedToolIds.mockResolvedValue(['tool-a']);
    await expect(s.authorization.authorize(principal(), script())).resolves.toBe(s.row);
  });

  it.each(['foreign-org', 'foreign-owner', 'removed-member', 'revoked-token', 'expired-token', 'license'])('denies %s', async (reason) => {
    const s = setup(); const p = principal();
    if (reason === 'foreign-org') p.organizationId = 'org-b';
    if (reason === 'foreign-owner') p.userId = 'other-user';
    if (reason === 'removed-member') s.prisma.user.findFirst.mockResolvedValue(null);
    if (reason === 'revoked-token') s.prisma.user.findFirst.mockResolvedValue({ id: 'owner', sessionsValidFrom: new Date(Date.now() + 1000) });
    if (reason === 'expired-token') p.tokenExpiresAtMs = Date.now() - 1;
    if (reason === 'license') s.license.checkLicenseActive.mockRejectedValue(new Error('private-license-details'));
    await expect(s.authorization.authorize(p, script())).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });

  it.each(['organization', 'owner', 'enabled', 'active', 'engine', 'method', 'auth', 'proxy', 'mapping'])('denies changed %s even with a freshly computed fingerprint', async (change) => {
    const s = setup();
    if (change === 'organization') s.row.connector.organizationId = 'org-b';
    if (change === 'owner') s.row.connector.userId = 'other-user';
    if (change === 'enabled') s.row.isEnabled = false;
    if (change === 'active') s.row.connector.isActive = false;
    if (change === 'engine') s.row.connector.type = 'MCP';
    if (change === 'method') s.row.endpointMapping = { method: 'DELETE', path: '/tasks' };
    if (change === 'auth') s.row.connector.authType = 'OAUTH2';
    if (change === 'proxy') s.row.useProxy = true;
    if (change === 'mapping') s.row.endpointMapping = { method: 'GET', path: '/changed' };
    const snapshot = change === 'mapping' ? script() : script(s.row);
    await expect(s.authorization.authorize(principal(), snapshot)).rejects.toThrow();
  });

  it('checks live MCP server attachment and distinguishes missing from revoked grants', async () => {
    const s = setup(); const p = principal(); p.origin = { kind: 'mcp', serverId: 'server-a', oauthClientId: 'client-a' };
    await s.authorization.authorize(p, script());
    expect(s.prisma.mcpServerConfig.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'server-a', organizationId: 'org-a', isActive: true,
      connectors: { some: { connectorId: 'connector-a', connector: { organizationId: 'org-a' } } },
    } }));
    for (const grant of [{ mode: 'none' }, { mode: 'organization', organizationId: 'org-b' }, { mode: 'servers', servers: [{ id: 'other', organizationId: 'org-a' }] }]) {
      s.grants.resolve.mockResolvedValue(grant);
      await expect(s.authorization.authorize(p, script())).rejects.toThrow();
    }
    s.grants.resolve.mockResolvedValue({ mode: 'servers', servers: [{ id: 'server-a', organizationId: 'org-a' }] });
    await expect(s.authorization.authorize(p, script())).resolves.toBe(s.row);
    s.prisma.mcpServerConfig.findFirst.mockResolvedValue(null);
    await expect(s.authorization.authorize(p, script())).rejects.toThrow();
  });

  it('canonicalizes nested key order but binds credential and mapping changes', () => {
    const a = tool(); const b = tool(); b.endpointMapping = { queryParams: { filter: '$filter' }, path: '/tasks', method: 'GET' };
    expect(fingerprintReadTool(a)).toBe(fingerprintReadTool(b));
    b.connector.envVars = { TOKEN: 'rotated' };
    expect(fingerprintReadTool(a)).not.toBe(fingerprintReadTool(b));
  });
});

describe('CODEBOUND trusted bounded REST adapter (HTTP mocked)', () => {
  it('keeps credentials in backend HTTP and bypasses all existing execution/cache paths', async () => {
    const s = setup();
    const result = await s.executor.execute(s.row, { filter: 'open' }, principal(), controls());
    expect(result).toEqual({ tasks: [{ priority: 1 }] });
    expect(http).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', url: 'https://api.example.com/v1/tasks', params: { filter: 'open' },
      headers: { Authorization: 'Bearer credential-canary-12345' }, proxy: false,
      signal: expect.any(AbortSignal), maxContentLength: MVP_LIMITS.maxConnectorResponseBytes,
    }), expect.objectContaining({ maxRedirects: 0 }));
    expect(JSON.stringify(result)).not.toContain('credential-canary');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown-arg', 'env-override', 'url-path', 'traversal', 'dynamic-header', 'write', 'engine', 'method-header', 'method-query'])('rejects %s before HTTP', async (reason) => {
    const s = setup(); let args: any = {};
    if (reason === 'unknown-arg') args = { url: 'https://evil.invalid' };
    if (reason === 'env-override') args = { TOKEN: 'attacker-token' };
    if (reason === 'url-path') s.row.endpointMapping = { method: 'GET', path: 'https://evil.invalid' };
    if (reason === 'traversal') { s.row.endpointMapping = { method: 'GET', path: '/tasks/{id}' }; args = { id: '../secrets' }; }
    if (reason === 'dynamic-header') s.row.endpointMapping = { method: 'GET', path: '/tasks', headers: { Authorization: '$filter' } };
    if (reason === 'write') s.row.endpointMapping = { method: 'POST', path: '/tasks' };
    if (reason === 'engine') s.row.connector.type = 'MCP';
    if (reason === 'method-header') s.row.connector.headers = { 'X-HTTP-Method-Override': 'DELETE' };
    if (reason === 'method-query') s.row.endpointMapping = { method: 'GET', path: '/tasks', queryParams: { _method: 'DELETE' } };
    await expect(s.executor.execute(s.row, args, principal(), controls())).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });

  it.each(['NONE', 'API_KEY', 'BASIC_AUTH'])('supports approved static authentication %s', async (authType) => {
    const s = setup(); s.row.connector.authType = authType as any;
    s.connectors.getDecryptedAuthConfig.mockReturnValue({ apiKey: 'static-key-12345', headerName: 'X-Key', username: 'fixture-user', password: 'static-password' } as any);
    await expect(s.executor.execute(s.row, {}, principal(), controls())).resolves.toEqual({ tasks: [{ priority: 1 }] });
    const headers = http.mock.calls[0][0].headers as Record<string, string>;
    if (authType === 'NONE') expect(headers.Authorization).toBeUndefined();
    if (authType === 'API_KEY') expect(headers['X-Key']).toBe('static-key-12345');
    if (authType === 'BASIC_AUTH') expect(headers.Authorization).toBe(`Basic ${Buffer.from('fixture-user:static-password').toString('base64')}`);
  });

  it('blocks credential echoes even in keys and rejects oversized responses', async () => {
    const s = setup();
    http.mockResolvedValueOnce({ data: { 'credential-canary-12345': 'echo' } } as any);
    await expect(s.executor.execute(s.row, {}, principal(), controls())).rejects.toThrow();
    http.mockResolvedValueOnce({ data: { text: 'x'.repeat(200) } } as any);
    await expect(s.executor.execute(s.row, {}, principal(), { ...controls(), maxResponseBytes: 100 })).rejects.toThrow();
  });

  it.each(['bearer', 'basic', 'cookie', 'query'].flatMap(kind =>
    ['raw', 'uri', 'base64'].map(encoding => [kind, encoding])))('blocks a credential component echoed from a static %s mapping (%s)', async (kind, encoding) => {
    const s = setup();
    s.row.connector.authType = 'NONE';
    s.row.connector.envVars = {};
    s.connectors.getDecryptedAuthConfig.mockReturnValue({} as any);
    const secret = 'static-credential+/98765';
    if (kind === 'bearer') s.row.connector.headers = { Authorization: `Bearer ${secret}` };
    if (kind === 'basic') s.row.connector.headers = { Authorization: `Basic ${Buffer.from(`fixture:${secret}`).toString('base64')}` };
    if (kind === 'cookie') s.row.connector.headers = { Cookie: `session=${secret}; preference=light` };
    if (kind === 'query') s.row.endpointMapping = { method: 'GET', path: '/tasks', queryParams: { access_token: secret } };
    const echoed = encoding === 'uri' ? encodeURIComponent(secret) : encoding === 'base64' ? Buffer.from(secret).toString('base64') : secret;
    http.mockResolvedValueOnce({ data: { [echoed]: 'echo' } } as any);
    await expect(s.executor.execute(s.row, {}, principal(), controls())).rejects.toThrow('Credential echo');
  });
});

describe('CODEBOUND gateway session and call accounting', () => {
  async function opened(s = setup(), c = controls()) {
    const result = await s.gateway.open(principal(), script(), 'execution-a', c);
    if (!result.ok) throw new Error('Fixture open failed');
    return { ...s, session: result.value };
  }

  it('returns only validated JSON in an opaque session and enforces one concurrent call', async () => {
    const s = await opened();
    expect(Object.keys(s.session)).toEqual([]);
    const first = s.gateway.call(s.session, call());
    const second = await s.gateway.call(s.session, call());
    expect(second).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorCalls' } });
    expect(await first).toMatchObject({ ok: false });
    expect(http).not.toHaveBeenCalled();
    await s.gateway.close(s.session);
  });

  it.each(['role', 'membership', 'definition', 'server', 'grant'])('revalidates revoked/changed %s between open and call', async (change) => {
    const s = setup(); const p = principal(); p.origin = { kind: 'mcp', serverId: 'server-a', oauthClientId: 'client-a' };
    const result = await s.gateway.open(p, script(), 'execution-a', controls());
    if (!result.ok) throw new Error('Fixture open failed');
    if (change === 'role') s.roles.getAllowedToolIds.mockResolvedValue([]);
    if (change === 'membership') s.prisma.user.findFirst.mockResolvedValue(null);
    if (change === 'definition') s.row.endpointMapping = { method: 'GET', path: '/changed' };
    if (change === 'server') s.prisma.mcpServerConfig.findFirst.mockResolvedValue(null);
    if (change === 'grant') s.grants.resolve.mockResolvedValue({ mode: 'none' });
    expect(await s.gateway.call(result.value, call())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).not.toHaveBeenCalled();
    await s.gateway.close(result.value);
  });

  it('rejects sandbox authority fields, closed sessions and execution ID replay', async () => {
    const s = await opened();
    expect(await s.gateway.call(s.session, { ...call(), organizationId: 'org-b' } as any)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await s.gateway.close(s.session);
    expect(await s.gateway.call(s.session, call())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.gateway.call({} as GatewaySession, call())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.gateway.open(principal(), script(), 'execution-a', controls())).toMatchObject({ ok: false });
    expect(http).not.toHaveBeenCalled();
  });

  it('sanitizes HTTP exceptions and reports response byte limits', async () => {
    const s = await opened();
    http.mockRejectedValueOnce(new Error('Authorization: credential-canary-12345'));
    const failure = await s.gateway.call(s.session, call());
    expect(failure).toMatchObject({ ok: false, error: { code: 'CONNECTOR_ERROR' } });
    expect(JSON.stringify(failure)).not.toContain('credential-canary');
    await s.gateway.close(s.session);
    const b = await opened(setup(), { ...controls(), maxResponseBytes: 10 });
    expect(await b.gateway.call(b.session, call())).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorResponseBytes' } });
    await b.gateway.close(b.session);
  });

  it('maps Axios transport byte limits without exposing request details', async () => {
    const s = await opened();
    http.mockRejectedValueOnce(new AxiosError(`maxContentLength size of ${MVP_LIMITS.maxConnectorResponseBytes} exceeded`, 'ERR_BAD_RESPONSE'));
    expect(await s.gateway.call(s.session, call())).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'connectorResponseBytes' } });
    await s.gateway.close(s.session);
  });

  it('close aborts an active HTTP operation and discards its late value', async () => {
    const s = await opened();
    let started!: () => void; let release!: (value: any) => void; let signal: AbortSignal | undefined;
    const began = new Promise<void>(resolve => { started = resolve; });
    http.mockImplementationOnce(config => {
      signal = config.signal as AbortSignal; started();
      return new Promise(resolve => { release = resolve; });
    });
    const pending = s.gateway.call(s.session, call());
    await began;
    await s.gateway.close(s.session);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(signal?.aborted).toBe(true);
    release({ data: { private: true } });
  });

  it('propagates cancellation to HTTP and ignores late responses', async () => {
    const controller = new AbortController();
    const s = await opened(setup(), { ...controls(), signal: controller.signal });
    http.mockImplementationOnce(async (config) => {
      expect(config.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      throw new AxiosError('aborted-secret');
    });
    expect(await s.gateway.call(s.session, call())).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    await s.gateway.close(s.session);
  });

  it('aborts active HTTP when the authenticated token expires', async () => {
    const s = setup(); const p = principal(); p.tokenExpiresAtMs = Date.now() + 300;
    const opened = await s.gateway.open(p, script(), 'short-token', controls());
    if (!opened.ok) throw new Error('Fixture open failed');
    let signal: AbortSignal | undefined; let release!: (value: any) => void;
    http.mockImplementationOnce(config => {
      signal = config.signal as AbortSignal;
      return new Promise(resolve => { release = resolve; });
    });
    expect(await s.gateway.call(opened.value, call())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(signal?.aborted).toBe(true);
    release({ data: {} });
    await s.gateway.close(opened.value);
  });

  it('detaches caller identity and resource controls from mutable open arguments', async () => {
    const s = setup(); const p = principal(); const c = controls();
    const opened = await s.gateway.open(p, script(), 'copied-authority', c);
    if (!opened.ok) throw new Error('Fixture open failed');
    p.organizationId = 'foreign-org'; c.maxResponseBytes = 1;
    expect(await s.gateway.call(opened.value, call())).toMatchObject({ ok: true });
    expect(s.roles.getAllowedToolIds).toHaveBeenLastCalledWith('owner', 'org-a');
    await s.gateway.close(opened.value);
  });

  it('does not dispatch HTTP after a DB authorization query exceeds its deadline', async () => {
    const s = await opened(setup(), { ...controls(), deadlineEpochMs: Date.now() + 250 });
    s.prisma.user.findFirst.mockImplementationOnce(() => new Promise(() => {}));
    expect(await s.gateway.call(s.session, call())).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'wallTime' } });
    expect(http).not.toHaveBeenCalled();
    await s.gateway.close(s.session);
  });

  it('denies revocation during license checks before reading execution authorization', async () => {
    const s = await opened();
    s.license.checkLicenseActive.mockImplementationOnce(async () => {
      s.prisma.user.findFirst.mockResolvedValue(null);
      s.roles.getAllowedToolIds.mockResolvedValue([]);
    });
    const result = await s.gateway.call(s.session, call());
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await s.gateway.close(s.session);
  });

  it.each(['membership', 'token', 'definition'])('rechecks %s after pending role work', async change => {
    const s = await opened();
    s.roles.getAllowedToolIds.mockImplementationOnce(async () => {
      if (change === 'membership') s.prisma.user.findFirst.mockResolvedValue(null);
      if (change === 'token') s.prisma.user.findFirst.mockResolvedValue({ id: 'owner', sessionsValidFrom: new Date(Date.now() + 1000) });
      if (change === 'definition') s.row.endpointMapping = { method: 'GET', path: '/changed' };
      return null;
    });
    expect(await s.gateway.call(s.session, call())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).not.toHaveBeenCalled();
    await s.gateway.close(s.session);
  });
});

describe('CODEBOUND multi-tool capabilities and bounded pagination', () => {
  const named = (name: string, index = 1, args: any = {}) => ({ type: 'connector.call' as const,
    requestId: `page-${index}`, binding: 'connector.tool' as const, toolName: name, arguments: args });
  async function open(s = setup(), snapshot = script(), p = principal(), c = controls()) {
    const result = await s.gateway.open(p, snapshot, 'multi-tool-test', c);
    if (!result.ok) throw new Error('Fixture open failed');
    return { ...s, session: result.value };
  }

  it.each(['mock_payroll_list_salaries', 'tool-a', 'foreign-tool-internal-id'])('denies unbound name or internal ID %s', async name => {
    const s = await open();
    expect(await s.gateway.call(s.session, named(name))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).not.toHaveBeenCalled();
    await s.gateway.close(s.session);
  });

  it('rejects a workspace B binding attached to an A script', async () => {
    const s = setup(); const foreign = tool();
    foreign.id = 'foreign-tool'; foreign.connectorId = 'foreign-connector'; foreign.connector.organizationId = 'org-b';
    const binding = { toolId: foreign.id, connectorId: foreign.connectorId, definitionSha256: fingerprintReadTool(foreign) };
    const snapshot = parseScriptSnapshot({ ...script(), additionalBindings: [binding] });
    s.prisma.mcpTool.findFirst.mockImplementation(async query => query.where?.id === 'tool-a' ? s.row : foreign);
    expect(await s.gateway.open(principal(), snapshot, 'foreign', controls())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).not.toHaveBeenCalled();
  });

  it('calls only an approved POST body mapping and keeps the legacy primary read', async () => {
    const s = setup(); const post = tool(); post.id = 'prices'; post.name = 'mock_supplier_get_prices';
    post.parameters = { type: 'object', properties: { skus: { type: 'array', items: { type: 'string' } } }, required: ['skus'] };
    post.endpointMapping = { method: 'POST', path: '/prices', bodyMapping: { skus: '$skus' } };
    s.prisma.mcpTool.findFirst.mockImplementation(async query => query.where?.id === 'prices' ? post : s.row);
    const snapshot = parseScriptSnapshot({ ...script(), additionalBindings: [{ toolId: post.id,
      connectorId: post.connectorId, definitionSha256: fingerprintReadTool(post) }] });
    const opened = await open(s, snapshot);
    expect(await s.gateway.call(opened.session, named(post.name, 1, { skus: ['sku-1'] }))).toMatchObject({ ok: true });
    expect(http).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', data: { skus: ['sku-1'] } }), expect.anything());
    expect(await s.gateway.call(opened.session, { ...call(), requestId: 'legacy-read' })).toMatchObject({ ok: true });
    // A live definition change invalidates even an additional approved capability.
    post.endpointMapping = { method: 'POST', path: '/other', bodyMapping: { skus: '$skus' } };
    expect(await s.gateway.call(opened.session, named(post.name, 3, { skus: [] }))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).toHaveBeenCalledTimes(2);
    await s.gateway.close(opened.session);
  });

  it('denies a key revoked between pages', async () => {
    const s = setup(); const p = principal(); p.origin = { kind: 'mcp', serverId: 'server-a', oauthClientId: null, apiKeyId: 'key-id' };
    const keys = { findFirst: jest.fn().mockResolvedValue({ id: 'key-id' }) };
    Object.assign(s.prisma, { mcpApiKey: keys });
    const opened = await open(s, script(), p);
    expect(await s.gateway.call(opened.session, named(s.row.name))).toMatchObject({ ok: true });
    keys.findFirst.mockResolvedValue(null);
    expect(await s.gateway.call(opened.session, named(s.row.name, 2))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).toHaveBeenCalledTimes(1);
    await s.gateway.close(opened.session);
  });

  it('denies Carol Staff access to an otherwise bound Payroll tool', async () => {
    const s = setup(); const carol = principal(); carol.userId = 'carol';
    s.row.id = 'payroll'; s.row.name = 'mock_payroll_list_salaries'; s.row.connector.userId = 'carol';
    s.roles.getAllowedToolIds.mockResolvedValue(['erp-ping', 'supplier-catalogue']);
    const snapshot = parseScriptSnapshot({ ...script(s.row), ownerUserId: 'carol' });
    expect(await s.gateway.open(carol, snapshot, 'carol-staff', controls())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(http).not.toHaveBeenCalled();
  });

  it('permits sanitized 503 recovery but never treats credential echoes as recoverable', async () => {
    const s = await open();
    http.mockResolvedValueOnce({ status: 503, data: { error: 'Temporarily unavailable' } } as any);
    expect(await s.gateway.call(s.session, named(s.row.name))).toMatchObject({ ok: false, recoverable: true,
      error: { code: 'CONNECTOR_ERROR', message: 'Connector operation failed' } });
    expect(await s.gateway.call(s.session, named(s.row.name, 2))).toMatchObject({ ok: true });
    http.mockResolvedValueOnce({ status: 503, data: { error: 'credential-canary-12345' } } as any);
    const denied = await s.gateway.call(s.session, named(s.row.name, 3));
    expect(denied).toMatchObject({ ok: false, error: { code: 'CONNECTOR_ERROR' } });
    expect(denied).not.toHaveProperty('recoverable');
    expect(JSON.stringify(denied)).not.toContain('credential-canary');
    await s.gateway.close(s.session);
  });

  it('stops at the connector-call ceiling without an extra HTTP request', async () => {
    const s = await open();
    for (let index = 1; index <= MVP_LIMITS.maxConnectorCalls; index++) {
      expect(await s.gateway.call(s.session, named(s.row.name, index))).toMatchObject({ ok: true });
    }
    expect(await s.gateway.call(s.session, named(s.row.name, 129))).toMatchObject({ ok: false,
      error: { code: 'RESOURCE_LIMIT', limit: 'connectorCalls' } });
    expect(http).toHaveBeenCalledTimes(128);
    await s.gateway.close(s.session);
  });

  it('bounds cumulative bytes across pages, including failed pages', async () => {
    const s = await open();
    http.mockResolvedValue({ status: 503, data: { message: 'x'.repeat(500_000) } } as any);
    for (let index = 1; index <= 16; index++) {
      expect(await s.gateway.call(s.session, named(s.row.name, index))).toMatchObject({ recoverable: true });
    }
    expect(s.gateway.responseBytes(s.session)).toBeGreaterThan(8_000_000);
    expect(await s.gateway.call(s.session, named(s.row.name, 17))).toMatchObject({ ok: false,
      error: { code: 'RESOURCE_LIMIT', limit: 'connectorResponseBytes' } });
    await s.gateway.close(s.session);
  });

  it('honors cancellation and deadlines after a successful pagination request', async () => {
    const controller = new AbortController(); const s = await open(setup(), script(), principal(), { ...controls(), signal: controller.signal });
    expect(await s.gateway.call(s.session, named(s.row.name))).toMatchObject({ ok: true });
    controller.abort();
    expect(await s.gateway.call(s.session, named(s.row.name, 2))).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(http).toHaveBeenCalledTimes(1);
    await s.gateway.close(s.session);
    const timed = await open(setup(), script(), principal(), { ...controls(), deadlineEpochMs: Date.now() + 150 });
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(await timed.gateway.call(timed.session, named(timed.row.name))).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', limit: 'wallTime' } });
    await timed.gateway.close(timed.session);
  });

  it('restricts local HTTP opt-in to exact kit origins in self-hosted development', () => {
    const env = { NODE_ENV: 'development', CODEBOUND_TEST_HTTP_ORIGINS: 'http://localhost:4102,http://localhost:4199' };
    expect(allowsCodeboundTestHttp(new URL('http://localhost:4102'), env)).toBe(true);
    for (const url of ['http://localhost:4199', 'http://localhost:80', 'http://127.0.0.1:4102', 'http://169.254.169.254:4102', 'http://evil.invalid:4102']) {
      expect(allowsCodeboundTestHttp(new URL(url), env)).toBe(false);
    }
    expect(allowsCodeboundTestHttp(new URL('http://localhost:4102'), { ...env, NODE_ENV: 'production' })).toBe(false);
    expect(allowsCodeboundTestHttp(new URL('http://localhost:4102'), { ...env, DEPLOYMENT_MODE: 'cloud' }, { isSelfHosted: () => false })).toBe(false);
    expect(allowsCodeboundTestHttp(new URL('http://localhost:4102'), {})).toBe(false);
  });
});
