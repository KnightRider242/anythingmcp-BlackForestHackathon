// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../auth/auth.service';
import { ScriptExecutionController } from './script-execution.controller';

describe('CODEBOUND controller disconnect boundary (execution mocked)', () => {
  it.each(['request', 'response'])('propagates an already disconnected %s before starting execution', async mode => {
    const jwt = new JwtService({ secret: 'codebound-public-controller-test-key' });
    const token = jwt.sign({ sub: 'verified-owner' }, { expiresIn: '1h' });
    const request = Object.assign(new EventEmitter(), { aborted: mode === 'request',
      headers: { authorization: `Bearer ${token}` }, user: { sub: 'verified-owner', organizationId: 'verified-org' } });
    const response = Object.assign(new EventEmitter(), { destroyed: mode === 'response', writableFinished: false,
      status: jest.fn() });
    const execution = { execute: jest.fn(async (principal, _body, signal) => {
      expect(principal).toMatchObject({ userId: 'verified-owner', organizationId: 'verified-org' });
      expect(signal.aborted).toBe(true);
      return { ok: false, error: { code: 'CANCELLED', message: 'Execution cancelled' } };
    }) };
    const controller = new ScriptExecutionController(execution as any, new AuthService(jwt));
    await controller.execute(request as any, response as any, { scriptId: 'script', expectedRevision: 1, input: {} });
    expect(response.status).toHaveBeenCalledWith(408);
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
});
