// SPDX-License-Identifier: AGPL-3.0-only
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../auth/auth.service';
import { dashboardPrincipal } from './dashboard-principal';
import { CreateScriptDto, RevisionDto, ScriptPageDto, UpdateScriptDto } from './script-management.dto';
import { ScriptBindingsService } from './script-bindings.service';

const definition = { name: 'Read', description: '', source: 'async function main() { return {}; }',
  inputSchema: {}, outputSchema: {}, binding: { connectorId: 'connector', toolId: 'tool', definitionSha256: 'a'.repeat(64) } };
describe('CODEBOUND management validation and picker (database/authorization mocked)', () => {
  it.each([
    [CreateScriptDto, { definition }, true], [CreateScriptDto, { definition, organizationId: 'forged' }, false],
    [CreateScriptDto, { definition: { ...definition, ownerUserId: 'forged' } }, false],
    [CreateScriptDto, { definition: { ...definition, source: 'x'.repeat(32769) } }, false],
    [CreateScriptDto, { definition: { ...definition, binding: { ...definition.binding, credentials: 'forged' } } }, false],
    [CreateScriptDto, {}, false], [RevisionDto, {}, false], [RevisionDto, { expectedRevision: '1' }, false],
    [RevisionDto, { expectedRevision: 1 }, true], [UpdateScriptDto, { definition, expectedRevision: 1 }, true],
    [UpdateScriptDto, { definition, expectedRevision: 0 }, false], [ScriptPageDto, { afterId: 'x' }, true],
    [ScriptPageDto, { limit: '10000' }, false],
  ] as const)('validates DTO case %#', async (dto, body, valid) => {
    const errors = await validate(plainToInstance(dto as any, body) as object, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length === 0).toBe(valid);
  });
  it('uses only guard identity and verified token timestamps', () => {
    const jwt = new JwtService({ secret: 'codebound-management-public-test-secret' });
    const token = jwt.sign({ sub: 'owner', organizationId: 'forged' }, { expiresIn: '1h' });
    const req = { user: { sub: 'owner', organizationId: 'live-org' }, headers: { authorization: `Bearer ${token}` } };
    expect(dashboardPrincipal(req as any, new AuthService(jwt))).toMatchObject({ userId: 'owner', organizationId: 'live-org' });
    expect(() => dashboardPrincipal({ ...req, user: { sub: 'other' } } as any, new AuthService(jwt))).toThrow();
    expect(() => dashboardPrincipal({ ...req, headers: {} } as any, new AuthService(jwt))).toThrow();
  });
  it('scopes, bounds, reauthorizes and projects picker results without configuration', async () => {
    const tools = Array.from({ length: 33 }, (_, i) => ({ id: String(i), connectorId: 'c', name: `Tool ${i}`,
      connector: { id: 'c', name: 'Owned', organizationId: 'org', userId: 'owner', authConfig: 'secret-canary' } }));
    const prisma = { mcpTool: { findMany: jest.fn().mockResolvedValue(tools) } };
    const authorization = { authorize: jest.fn().mockImplementation(async (_p, s) => { if (s.binding.toolId === '1') throw Error('Denied'); }) };
    const picker = new ScriptBindingsService(prisma as any, authorization as any);
    const result = await picker.list({ userId: 'owner', organizationId: 'org' } as any, 'cursor');
    expect(prisma.mcpTool.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 33, where: expect.objectContaining({
      id: { gt: 'cursor' }, connector: { organizationId: 'org', userId: 'owner', isActive: true, type: 'REST' } }) }));
    expect(authorization.authorize).toHaveBeenCalledTimes(32);
    expect(result.items).toHaveLength(31); expect(result.nextCursor).toBe('31');
    expect(JSON.stringify(result)).not.toContain('secret-canary');
    expect(result.items.every(i => i.binding.toolId !== '1')).toBe(true);
  });
});
