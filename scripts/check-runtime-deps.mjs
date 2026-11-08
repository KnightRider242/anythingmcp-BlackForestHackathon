#!/usr/bin/env node
/**
 * Verify the production Dockerfile packages all backend runtime dependencies.
 *
 * npm can nest a second package version under packages/backend/node_modules.
 * The runtime image must copy that directory AFTER hoisted /app/node_modules
 * into ./backend/node_modules, or NestJS resolves the wrong/missing version.
 *
 * The CI smoke-build then boots the assembled image to catch runtime issues.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NESTED = 'packages/backend/node_modules/';

/** Production dependencies npm nests in the backend workspace. */
export function nestedRuntimeDeps(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, meta]) => path.startsWith(NESTED) && !meta.dev)
    .map(([path, meta]) => ({ name: path.slice(NESTED.length), version: meta.version }));
}

/** Verify both trees are copied in the correct order into the runtime image. */
export function assertNestedDepsPackaged(lock, dockerfile) {
  const nested = nestedRuntimeDeps(lock);
  if (nested.length === 0) return nested;
  const copies = dockerfile.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^COPY\s+/.test(line) && line.includes('--from=backend-prod-deps'));
  const hoisted = copies.findIndex(line =>
    /\s\/app\/node_modules\s+\.\/backend\/node_modules$/.test(line));
  const overlay = copies.findIndex(line =>
    /\s\/app\/packages\/backend\/node_modules\s+\.\/backend\/node_modules$/.test(line));
  if (hoisted < 0 || overlay <= hoisted) {
    throw new Error('Dockerfile must copy hoisted backend production deps and then overlay ' +
      'packages/backend/node_modules into ./backend/node_modules');
  }
  return nested;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const lockPath = process.argv[2] ?? join(root, 'package-lock.json');
  const dockerfilePath = join(root, 'Dockerfile');
  try {
    const nested = assertNestedDepsPackaged(
      JSON.parse(readFileSync(lockPath, 'utf8')),
      readFileSync(dockerfilePath, 'utf8'),
    );
    if (nested.length === 0) {
      console.log('All backend production dependencies hoisted; runtime image packages them.');
    } else {
      console.log('Verified backend nested-dependency overlay in production Dockerfile:');
      for (const item of nested) console.log('  - ' + item.name + '@' + item.version);
    }
  } catch (error) {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  }
}
