// SPDX-License-Identifier: AGPL-3.0-only
import { McpEndpointController } from '../../mcp-server/mcp-endpoint.controller';
import { CODEBOUND_TOOL_PREFIX } from './codebound-mcp-tools.service';

describe('CODEBOUND registration in the existing endpoint (dependencies mocked)', () => {
  it('never registers a connector in the reserved script namespace', () => {
    const controller = new McpEndpointController({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const entries = (controller as any).planToolSet({ serverTools: [{ name: CODEBOUND_TOOL_PREFIX + 'collision' }], allowedToolIds: null,
      captureIntent: false, kgEnabled: false, invocationContext: { mcpServerId: 'server', connectorIds: [] } });
    expect(entries).toEqual([]);
  });

  it('serializes overlapping lifecycle and request reconciliation', async () => {
    let release!: () => void; let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const servers = { getConnectorIds: jest.fn().mockImplementationOnce(async () => { started(); await wait; return []; }).mockResolvedValue([]) };
    const session = { handles: new Map(), signature: '' };
    const controller = new McpEndpointController(servers as any, { getAllTools: () => [] } as any, {} as any,
      {} as any, {} as any, { get: () => session } as any, {} as any, {} as any);
    const rebuild = (controller as any).makeRebuild('session', 'server', 'org', {}, false, false, { mcpServerId: 'server', connectorIds: [] });
    const first = rebuild(); await began; const second = rebuild();
    for (let i = 0; i < 1000; i++) expect(rebuild()).toBe(first);
    expect(servers.getConnectorIds).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
    expect(servers.getConnectorIds).toHaveBeenCalledTimes(2);
  });
});
