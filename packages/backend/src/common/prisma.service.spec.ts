import { PrismaService } from './prisma.service';
import { Logger } from '@nestjs/common';

describe('PrismaService.tenantTx', () => {
  it('does not log bound variables from a failed reconciliation query', async () => {
    const svc = new PrismaService();
    const secret = 'private-fixture-reconciliation-token';
    jest.spyOn(svc as any, '$queryRaw').mockRejectedValue(new Error(`SQL variables: ${secret}`));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      expect(await svc.reconcileEnvVarsAtRest()).toEqual({ changed: 0 });
      expect(log).toHaveBeenCalledWith('Connector variables could not be reconciled');
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { log.mockRestore(); }
  });

  it('sets app.current_org transaction-locally, then runs the callback', async () => {
    const svc = new PrismaService();
    const setConfigCalls: unknown[][] = [];
    const fakeTx = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        setConfigCalls.push([strings.join('?'), ...values]);
        return Promise.resolve(1);
      },
    };
    // Don't hit a real DB: run the callback against the fake tx.
    jest
      .spyOn(svc as any, '$transaction')
      .mockImplementation((cb: any) => cb(fakeTx));

    const result = await svc.tenantTx('org-123', async (tx) => {
      expect(tx).toBe(fakeTx);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(setConfigCalls).toHaveLength(1);
    const [sql, orgValue] = setConfigCalls[0];
    expect(sql).toContain("set_config('app.current_org'");
    expect(sql).toContain('true'); // is_local = transaction-scoped
    expect(orgValue).toBe('org-123');
  });

  it('rejects an empty organizationId (fail closed)', async () => {
    const svc = new PrismaService();
    const tx = jest.spyOn(svc as any, '$transaction');
    await expect(svc.tenantTx('', async () => 'x')).rejects.toThrow(/organizationId/);
    expect(tx).not.toHaveBeenCalled();
  });
});
