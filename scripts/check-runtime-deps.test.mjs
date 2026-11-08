import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedRuntimeDeps, assertNestedDepsPackaged } from './check-runtime-deps.mjs';

const hoistedCopy = 'COPY --from=backend-prod-deps /app/node_modules ./backend/node_modules';
const nestedCopy = 'COPY --from=backend-prod-deps --chown=appuser:appuser /app/packages/backend/node_modules ./backend/node_modules';

test('lists backend-only production packages nested by npm', () => {
  const lock = { packages: {
    'node_modules/js-yaml': { version: '4.3.2' },
    'packages/backend/node_modules/js-yaml': { version: '5.5.0' },
    'packages/backend/node_modules/js-yaml/node_modules/argparse': { version: '3.0.4' },
  } };
  assert.deepEqual(nestedRuntimeDeps(lock).map(item => item.name), [
    'js-yaml', 'js-yaml/node_modules/argparse',
  ]);
  assert.equal(assertNestedDepsPackaged(lock, hoistedCopy + '\n' + nestedCopy).length, 2);
});

test('rejects Dockerfiles that omit or misorder backend nested package overlay', () => {
  const lock = { packages: { 'packages/backend/node_modules/@modelcontextprotocol/core': {
    version: '2.4.0',
  } } };
  assert.throws(() => assertNestedDepsPackaged(lock, hoistedCopy), /overlay/);
  assert.throws(() => assertNestedDepsPackaged(lock, nestedCopy + '\n' + hoistedCopy), /overlay/);
  assert.throws(() => assertNestedDepsPackaged(lock, '# ' + nestedCopy + '\n' + hoistedCopy), /overlay/);
});

test('ignores dev-only nested packages and hoisted packages', () => {
  const lock = { packages: {
    'node_modules/js-yaml': { version: '4.3.2' },
    'packages/backend/node_modules/typescript': { version: '6.0.0', dev: true },
    'packages/frontend/node_modules/react': { version: '19.0.0' },
  } };
  assert.deepEqual(nestedRuntimeDeps(lock), []);
  assert.deepEqual(assertNestedDepsPackaged(lock, ''), []);
});
