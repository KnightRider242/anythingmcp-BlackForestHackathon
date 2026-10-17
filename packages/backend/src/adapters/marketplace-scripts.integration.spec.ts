// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const live = process.env.RUN_CODEBOUND_MARKETPLACE_LIVE === '1' ? describe : describe.skip;
live('marketplace installation: real AppModule/JWT/PostgreSQL/Docker/HTTPS/MCP', () => {
  it('installs, retries, rolls back failures, isolates owners and executes through HTTP and MCP', async () => {
    const result = await promisify(execFile)(process.execPath, [resolve(__dirname, 'fixtures/marketplace-flow.cjs')], {
      cwd: resolve(__dirname, '../..'), env: process.env, timeout: 110_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(result.stdout).toContain('CODEBOUND_MARKETPLACE_OK');
  }, 115_000);
});
