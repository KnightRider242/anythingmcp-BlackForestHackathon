// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const live = process.env.RUN_CODEBOUND_APP_LIVE === '1' ? describe : describe.skip;

live('CODEBOUND actual built AppModule (no provider overrides)', () => {
  it('boots production providers and exposes the JWT-guarded execution route', async () => {
    // Node's production loader supports the existing openid-client ESM dependency;
    // Jest's CJS loader on Node 22 does not. No providers are overridden.
    const result = await promisify(execFile)(process.execPath, [resolve(__dirname, 'fixtures/app-wiring.cjs')], {
      cwd: resolve(__dirname, '../../..'), env: process.env, timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    expect(result.stdout).toContain('CODEBOUND_APP_SMOKE_OK');
  }, 65_000);
});
