import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pinoHttp from 'pino-http';
import { AppLoggerModule } from './logger.module';

describe('HTTP log confidentiality', () => {
  it('omits credential-bearing request/response fields and exception payloads', async () => {
    // Exercise the module's actual Pino configuration and serializers, including
    // child-logger bindings, rather than testing a separate sanitizer.
    const module = Reflect.getMetadata('imports', AppLoggerModule)[0];
    const params = module.providers.find((p: any) => p.provide === 'pino-params').useValue;
    const secret = 'private-fixture-key+/9437';
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')];
    let logs = '';
    const middleware = pinoHttp({ ...params.pinoHttp, transport: undefined }, { write: text => { logs += text; } });
    const server = createServer((req, res) => middleware(req, res, () => {
      req.log.error({ err: Object.assign(new Error(secret), { config: { headers: { Authorization: secret } } }) }, 'Request failed');
      res.setHeader('X-Upstream-Token', secret);
      res.end('ok');
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const value of forms) {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${encodeURIComponent(value)}?token=${encodeURIComponent(value)}`, {
          headers: { authorization: `Bearer ${value}`, 'x-api-key': value, 'x-custom-token': value, 'x-request-id': value, 'x-correlation-id': value },
        });
        await response.text();
        expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(response.headers.get('x-request-id')).not.toBe(value);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const value of forms) expect(logs).not.toContain(value);
    const records = logs.trim().split('\n').map(line => JSON.parse(line));
    expect(records.some(record => record.res?.statusCode === 200)).toBe(true);
    expect(records.some(record => record.req?.method === 'GET')).toBe(true);
    expect(records.some(record => record.err?.type === 'Error')).toBe(true);
  });
});
