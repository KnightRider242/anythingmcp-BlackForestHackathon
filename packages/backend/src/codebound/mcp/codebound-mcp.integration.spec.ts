// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const live = process.env.RUN_CODEBOUND_MCP_LIVE === '1' ? describe : describe.skip;
live('CODEBOUND real MCP / AppModule / PostgreSQL / Docker / HTTPS', () => {
  it.each(['stateless', 'stateful'])('discovers, executes and revokes scripts through %s MCP HTTP', async mode => {
    // Production Node loader, since the full app has existing ESM dependencies
    // that Jest's Node 22 CJS loader cannot load. No app provider is mocked.
    const result = await promisify(execFile)(process.execPath, [resolve(__dirname, 'fixtures/mcp-flow.cjs'), mode], {
      cwd: resolve(__dirname, '../../..'), env: process.env, timeout: 100_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(result.stdout).toContain(`CODEBOUND_MCP_OK:${mode}`);
  }, 105_000);
});
