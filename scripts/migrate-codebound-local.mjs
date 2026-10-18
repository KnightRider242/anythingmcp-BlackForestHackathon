// SPDX-License-Identifier: AGPL-3.0-only
// Deploy additive migrations ONLY to the existing isolated CODEBOUND database.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, ...parseEnv(readFileSync(resolve(root, '.env.codebound.local'), 'utf8')) };
const database = new URL(env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== 'localhost' ||
    database.port !== '5434' || database.pathname !== '/codeboundkit' || env.PORT !== '4001') {
  throw new Error('Refusing migrations outside the existing localhost:5434/codeboundkit database');
}
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: resolve(root, 'packages/backend'), env, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw new Error('Cannot launch CODEBOUND migration');
process.exitCode = result.status ?? 1;
