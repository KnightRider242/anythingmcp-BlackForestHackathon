// SPDX-License-Identifier: AGPL-3.0-only
import { getAdapter } from './catalog';
import { MarketplaceScriptsService } from './marketplace-scripts.service';

describe('marketplace installation boundary (database and persistence mocked)', () => {
  const setup = () => {
    const adapter = JSON.parse(JSON.stringify(getAdapter('hackernews')));
    const principal = { userId: 'owner', organizationId: 'org', origin: { kind: 'dashboard' } };
    const data = { userId: 'owner', organizationId: 'org', name: 'Fixture', type: 'REST', config: {} };
    const tool = { id: 'actual-tool', connectorId: 'actual-connector', connector: { id: 'actual-connector', organizationId: 'org', userId: 'owner' } };
    const tx = { $executeRaw: jest.fn(), connector: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'actual-connector' }) },
      mcpTool: { createMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(tool) } };
    const db = { $transaction: jest.fn(fn => fn(tx)) };
    const scripts = { createForInstallation: jest.fn().mockResolvedValue({ ok: true, value: {} }), list: jest.fn().mockResolvedValue({ ok: true, value: [] }) };
    const service = new MarketplaceScriptsService(db as any, scripts as any);
    const rows = jest.fn().mockReturnValue([]);
    const install = () => service.install(adapter, principal as any, data as any, rows);
    return { adapter, principal, data, tx, db, scripts, rows, install };
  };
  it('resolves actual IDs and uses persistence within the same transaction, never evaluating source', async () => {
    const s = setup(); const result = await s.install();
    expect(result).toMatchObject({ connectorId: 'actual-connector', scriptsInstalled: 1 });
    expect(s.rows).toHaveBeenCalledWith('actual-connector');
    expect(s.scripts.createForInstallation).toHaveBeenCalledWith(s.principal, expect.objectContaining({
      source: s.adapter.codeboundScripts[0].source, binding: expect.objectContaining({ connectorId: 'actual-connector', toolId: 'actual-tool' }) }), s.tx);
  });
  it.each(['organizationId', 'userId'])('rejects a mismatched %s before DB access', async key => {
    const s = setup(); (s.principal as any)[key] = 'forged';
    await expect(s.install()).rejects.toThrow('Script installation denied'); expect(s.db.$transaction).not.toHaveBeenCalled();
  });
  it('reuses existing installation without recreating or overwriting scripts', async () => {
    const s = setup(); s.tx.connector.findFirst.mockResolvedValue({ id: 'existing' });
    expect(await s.install()).toMatchObject({ connectorId: 'existing', scriptsInstalled: 0 });
    expect(s.tx.connector.create).not.toHaveBeenCalled(); expect(s.scripts.createForInstallation).not.toHaveBeenCalled();
    expect(s.scripts.list).toHaveBeenCalledWith(s.principal, { limit: 1 });
  });
  it('refuses installation without the supported verified dashboard principal', async () => {
    const s = setup(); (s.principal as any).origin = { kind: 'mcp', serverId: 'server', oauthClientId: null };
    await expect(s.install()).rejects.toThrow('Script installation denied'); expect(s.db.$transaction).not.toHaveBeenCalled();
  });
  it('reauthenticates retries instead of trusting the persisted marker', async () => {
    const s = setup(); s.tx.connector.findFirst.mockResolvedValue({ id: 'existing' });
    s.scripts.list.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN' } } as any);
    await expect(s.install()).rejects.toThrow('Script installation denied');
  });
  it.each(['FORBIDDEN', 'INVALID_INPUT', 'INTERNAL_ERROR'])('aborts when persistence returns %s', async code => {
    const s = setup(); s.scripts.createForInstallation.mockResolvedValue({ ok: false, error: { code } } as any);
    await expect(s.install()).rejects.toThrow();
  });
  it('aborts when the referenced tool was not inserted', async () => {
    const s = setup(); s.tx.mcpTool.findFirst.mockResolvedValue(null);
    await expect(s.install()).rejects.toThrow('Marketplace script tool unavailable'); expect(s.scripts.createForInstallation).not.toHaveBeenCalled();
  });
  it('aborts and sanitizes a tool insertion failure before persistence runs', async () => {
    const s = setup(); s.tx.mcpTool.createMany.mockRejectedValue(new Error('private-tool-row-canary'));
    await expect(s.install()).rejects.toThrow('Marketplace script installation failed');
    expect(s.scripts.createForInstallation).not.toHaveBeenCalled();
    try { await s.install(); } catch (error) { expect(String(error)).not.toContain('private-tool-row-canary'); }
  });
  it('sanitizes unexpected database failures', async () => {
    const s = setup(); s.tx.connector.create.mockRejectedValue(new Error('credential-canary-in-prisma-error'));
    await expect(s.install()).rejects.toThrow('Marketplace script installation failed');
    await expect(s.install()).rejects.not.toThrow('credential-canary');
  });
});
