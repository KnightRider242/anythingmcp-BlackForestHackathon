// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, { port = '5434', buildExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codebound-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'packages/backend/dist/src'), { recursive: true });
  const helper = join(root, 'scripts/codebound-local.mjs');
  copyFileSync(new URL('./codebound-local.mjs', import.meta.url), helper);
  writeFileSync(join(root, '.env.codebound.local'), [
    `DATABASE_URL=postgresql://fixture:fixture@localhost:${port}/fixture`,
    'PORT=4001', 'JWT_SECRET=fixture-jwt', 'ENCRYPTION_KEY=fixture-encryption',
  ].join('\n'));
  const npm = join(root, 'npm.cjs');
  writeFileSync(npm, `
    const fs = require('node:fs');
    fs.writeFileSync('build.json', JSON.stringify({
      args: process.argv.slice(2), port: process.env.PORT,
      databasePort: new URL(process.env.DATABASE_URL).port,
      preservedSecrets: process.env.JWT_SECRET === 'fixture-jwt' && process.env.ENCRYPTION_KEY === 'fixture-encryption'
    }));
    process.exit(${buildExit});
  `);
  writeFileSync(join(root, 'packages/backend/dist/src/main.js'), "require('node:fs').writeFileSync('started', 'yes'); process.stdout.write('stdout fixture\\n'); process.stderr.write('stderr fixture\\n');");
  return { root, run: (action, ...args) => spawnSync(process.execPath, [helper, action, ...args], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, npm_execpath: npm,
      DATABASE_URL: 'postgresql://fixture:fixture@localhost:5433/main', PORT: '4000',
      JWT_SECRET: 'inherited-jwt', ENCRYPTION_KEY: 'inherited-encryption' },
  }) };
}

test('passes saved environment and unchanged secrets to the npm child from any cwd', t => {
  const f = fixture(t);
  assert.equal(f.run('build').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'build.json'), 'utf8')), {
    args: ['run', 'build:backend'], port: '4001', databasePort: '5434', preservedSecrets: true,
  });
  assert.equal(existsSync(join(f.root, 'started')), false);
});

test('refuses the main database before launching any subprocess', t => {
  const f = fixture(t, { port: '5433' });
  assert.notEqual(f.run('start').status, 0);
  assert.equal(existsSync(join(f.root, 'build.json')), false);
  assert.equal(existsSync(join(f.root, 'started')), false);
});

test('does not start stale compiled output after a failed build', t => {
  const f = fixture(t, { buildExit: 7 });
  assert.equal(f.run('start').status, 7);
  assert.equal(existsSync(join(f.root, 'started')), false);
});

test('starts compiled backend after a successful build', t => {
  const f = fixture(t);
  assert.equal(f.run('start').status, 0);
  assert.equal(readFileSync(join(f.root, 'started'), 'utf8'), 'yes');
});

test('captures both backend streams as UTF-8 and preserves previous log contents', t => {
  const f = fixture(t);
  const log = join(f.root, 'backend.log');
  writeFileSync(log, 'previous UTF-8 evidence\n');
  assert.equal(f.run('start', '--log', log).status, 0);
  const text = readFileSync(log, 'utf8');
  assert.ok(text.startsWith('previous UTF-8 evidence\n'));
  assert.ok(text.includes('stdout fixture\n'));
  assert.ok(text.includes('stderr fixture\n'));
  assert.equal(text.includes('\0'), false);
});
