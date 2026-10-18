// SPDX-License-Identifier: AGPL-3.0-only
import { McpEndpointController } from './mcp-endpoint.controller';

describe('authenticated per-server MCP role-denial auditing', () => {
  const payroll = { id: 'payroll-A', name: 'payroll', connectorId: 'connector-A', organizationId: 'A' };
  let controller: McpEndpointController;
  let audit: { logInvocation: jest.Mock };
  let executor: { executeTool: jest.Mock };
  let response: any;
  const body = { jsonrpc: '2.0', method: 'tools/call', id: 'untrusted-request-id',
    params: { name: 'payroll', arguments: { secret: 'must-not-be-stored' } } };
  beforeEach(() => {
    audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    executor = { executeTool: jest.fn() };
    controller = new McpEndpointController({
      findById: jest.fn().mockResolvedValue({ id: 'server-A', organizationId: 'A', isActive: true }),
      getConnectorIds: jest.fn().mockResolvedValue(['connector-A']),
    } as any, { getAllTools: () => [payroll] } as any, executor as any,
    { getAllowedToolIds: jest.fn().mockResolvedValue([]) } as any,
    {} as any, {} as any, {} as any, {} as any, undefined, undefined, audit as any);
    response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  });
  const deny = () => (controller as any).refuseRoleRestrictedCall(body, response, [payroll], [],
    { sub: 'carol', organizationId: 'B', email: 'sensitive-email', apiKeyName: 'sensitive-key-name' }, 'A', 'server-A');

  it('awaits a fixed bounded audit for the authenticated caller in the server workspace', async () => {
    let persist!: () => void;
    audit.logInvocation.mockImplementation(() => new Promise<void>(resolve => { persist = resolve; }));
    const pending = deny();
    expect(response.json).not.toHaveBeenCalled();
    persist();
    expect(await pending).toBe(true);
    expect(audit.logInvocation).toHaveBeenCalledWith({ toolId: 'payroll-A', userId: 'carol',
      organizationId: 'A', mcpServerId: 'server-A', input: {}, status: 'ERROR',
      error: 'FORBIDDEN: Tool access denied', clientInfo: 'mcp/authorization', durationMs: 0, deduplicate: false });
    expect(JSON.stringify(audit.logInvocation.mock.calls)).not.toMatch(/must-not|untrusted|sensitive/);
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(/payroll|connector|Staff|definition/);
    expect(executor.executeTool).not.toHaveBeenCalled();
  });
  it('records repeated refusals separately without copying arguments', async () => {
    await deny(); await deny();
    expect(audit.logInvocation).toHaveBeenCalledTimes(2);
    expect(audit.logInvocation.mock.calls.every(([data]) => data.deduplicate === false)).toBe(true);
  });
  it('does not resolve a foreign tool or change policy for allowed calls', async () => {
    for (const [tools, allowed] of [[[payroll], ['payroll-A']], [[{ ...payroll, organizationId: 'B' }], []], [[], []]]) {
      expect(await (controller as any).refuseRoleRestrictedCall(body, response, tools, allowed, { sub: 'carol' }, 'A', 'server-A')).toBe(false);
    }
    expect(audit.logInvocation).not.toHaveBeenCalled();
  });
  it('keeps the refusal when audit persistence throws and never logs its exception', async () => {
    const log = jest.spyOn((controller as any).logger, 'error').mockImplementation(() => undefined);
    audit.logInvocation.mockRejectedValue(new Error('must-not-be-stored'));
    expect(await deny()).toBe(true);
    expect(log).toHaveBeenCalledWith('MCP denial audit unavailable');
    expect(executor.executeTool).not.toHaveBeenCalled(); log.mockRestore();
  });
  it('audits the ordinary POST before it can route to an existing session', async () => {
    const route = jest.spyOn(controller as any, 'routeToSession').mockResolvedValue(true);
    await controller.handlePost('server-A', { user: { sub: 'carol', organizationId: 'A' }, headers: {} } as any, response, body);
    expect(audit.logInvocation).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    expect(executor.executeTool).not.toHaveBeenCalled();
  });
});
