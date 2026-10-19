#!/usr/bin/env bash
# CODEBOUND bootstrap for the combined AnythingMCP source application.
# Uses the host's trusted Docker daemon to launch disposable sandboxes.
# Does not install the official hackathon kit, touch existing credentials,
# reset databases, expose Docker sockets, or mutate existing user data.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '[CODEBOUND] %s\n' "$*"; }
fail() { printf '[CODEBOUND] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" != "" && "${1:-}" != "--existing" ]]; then
  fail 'Usage: bash scripts/setup-codebound.sh [--existing]'
fi

[[ -f .env ]] || fail 'Missing .env; run bash setup.sh and choose Local development + CODEBOUND first.'
[[ -f deploy/codebound/Dockerfile && -f packages/backend/prisma.config.ts ]] || fail 'CODEBOUND source files are missing from this checkout.'

for command in node npm docker; do
  command -v "$command" >/dev/null 2>&1 || fail "Required executable not found: $command"
done

docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
docker info >/dev/null 2>&1 || fail 'Cannot reach the Docker daemon. Start Docker and retry.'
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || fail 'CODEBOUND requires Docker Linux containers.'

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("[CODEBOUND] Node.js 22.12+ is required"); process.exit(1); }'

# Parse (never execute) the existing environment and refuse Docker-only URLs.
# The trusted backend must run on the host in this supported development setup.
node - "$ROOT/.env" <<'NODE'
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
let env;
try { env = parseEnv(readFileSync(process.argv[2], 'utf8')); }
catch { console.error('[CODEBOUND] Invalid .env file'); process.exit(1); }
const required = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'POSTGRES_PASSWORD'];
if (required.some(key => !env[key])) {
  console.error('[CODEBOUND] Missing required .env values. Keep existing secrets; do not regenerate them.');
  process.exit(1);
}
let url;
try { url = new URL(env.DATABASE_URL); }
catch { console.error('[CODEBOUND] DATABASE_URL is invalid'); process.exit(1); }
if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)) {
  console.error('[CODEBOUND] Existing .env uses a non-local database URL. Docker-only AnythingMCP is not a supported CODEBOUND execution target; choose the integrated local source mode instead.');
  process.exit(1);
}
if (url.pathname !== '/anythingmcp' || url.username !== 'amcp' || !env.POSTGRES_PORT ||
    Number(env.POSTGRES_PORT) !== Number(url.port || '5432')) {
  console.error('[CODEBOUND] Expected the existing local AnythingMCP PostgreSQL database and matching POSTGRES_PORT. Refusing to migrate the isolated kit or an unrelated database.');
  process.exit(1);
}
if (decodeURIComponent(url.password) !== env.POSTGRES_PASSWORD) {
  console.error('[CODEBOUND] DATABASE_URL password differs from POSTGRES_PASSWORD in .env. Preserve existing secrets and correct the configuration.');
  process.exit(1);
}
if (env.NODE_ENV !== 'development') {
  console.error('[CODEBOUND] Existing .env must have NODE_ENV=development for this host-mode installer.');
  process.exit(1);
}
if (!/^\d{1,5}$/.test(env.PORT ?? '') || +env.PORT < 1 || +env.PORT > 65535) {
  console.error('[CODEBOUND] .env PORT must be a valid TCP port.');
  process.exit(1);
}
NODE

say 'Starting the existing PostgreSQL service without resetting its volume...'
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait --wait-timeout 120 postgres

if [[ ! -f node_modules/prisma/build/index.js ]]; then
  say 'Installing locked npm dependencies...'
  npm ci
fi

say 'Applying existing (including CODEBOUND) Prisma migrations...'
node - "$ROOT" <<'NODE'
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const root = process.argv[2];
const env = { ...process.env, ...parseEnv(readFileSync(join(root, '.env'), 'utf8')) };
for (const args of [['migrate', 'deploy'], ['generate']]) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), ...args], {
    cwd: join(root, 'packages/backend'), env, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
NODE

say 'Building the isolated CODEBOUND Linux sandbox image...'
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
docker image inspect codebound-sandbox:mvp >/dev/null

say 'Setup complete. CODEBOUND is integrated into the existing AnythingMCP backend and UI.'
say 'Start both development services with: npm run codebound:dev'
say 'Then open /scripts and /scripts/runs in the frontend (normally http://localhost:3000).'
say 'No demo users, mock connectors, or scripts were created; configure your own approved REST tools.'
