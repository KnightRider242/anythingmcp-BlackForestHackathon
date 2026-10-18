// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, createWriteStream } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2];
if (!['build', 'start'].includes(action)) throw new Error('Expected build or start');
const logFile = process.argv[3] === '--log' ? process.argv[4] : undefined;
if (process.argv.length > 3 && (!logFile || action !== 'start' || process.argv.length !== 5)) throw new Error('Expected start --log <file>');
// Explicitly pass the file's values to every child, including npm and Prisma.
// Node --env-file combined with --run does not reliably propagate them on Windows.
const env = { ...process.env, ...parseEnv(readFileSync(resolve(root, '.env.codebound.local'), 'utf8')) };
let database;
try { database = new URL(env.DATABASE_URL); }
catch { throw new Error('CODEBOUND DATABASE_URL must be a valid local PostgreSQL URL'); }
if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5434' || env.PORT !== '4001') {
  throw new Error('CODEBOUND requires localhost database port 5434 and backend port 4001');
}
if (!env.JWT_SECRET || !env.ENCRYPTION_KEY) throw new Error('Existing CODEBOUND secrets must be configured');
if (!process.env.npm_execpath) throw new Error('Run via npm run codebound:build or npm run codebound:start');

async function run(args, capture = false) {
  const log = capture && logFile ? createWriteStream(resolve(logFile), { flags: 'a' }) : undefined;
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: log ? ['inherit', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
    if (log) {
      // Raw UTF-8 buffers: PowerShell redirection can otherwise mix UTF-16/UTF-8.
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      log.once('error', () => { child.kill(); reject(new Error('CODEBOUND log capture failed')); });
    }
    child.once('error', reject);
    // Piped stdout/stderr may still contain bytes when exit fires.
    child.once('close', code => resolveExit(code ?? 1));
  });
  if (log) await new Promise(resolveEnd => log.end(resolveEnd));
  if (code !== 0) process.exit(code);
}

// Start only after a successful build: a failed Prisma/Nest build must never
// leave the test instance running an older bridge without API-key support.
await run([process.env.npm_execpath, 'run', 'build:backend']);
if (action === 'start') await run([resolve(root, 'packages/backend/dist/src/main.js')], true);
