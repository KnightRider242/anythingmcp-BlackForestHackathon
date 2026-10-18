// SPDX-License-Identifier: AGPL-3.0-only
// Run the integrated source application with the root .env inherited by both
// workspaces. Avoid DATABASE_URL lookup failures when starting Nest/Prisma.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));
if (!envFile.DATABASE_URL || !envFile.JWT_SECRET || !envFile.ENCRYPTION_KEY) {
  throw new Error('Missing required configuration in root .env. Run bash setup.sh first.');
}
const port = envFile.PORT || '4000';
if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid PORT in .env');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start via npm run codebound:dev');
const env = { ...process.env, ...envFile,
  BACKEND_INTERNAL_URL: envFile.BACKEND_INTERNAL_URL || `http://127.0.0.1:${port}`,
};
const child = spawn(process.execPath, [npmCli, 'run', 'dev'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error('Could not start development services:', error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
