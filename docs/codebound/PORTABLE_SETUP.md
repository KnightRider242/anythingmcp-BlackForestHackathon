# Portable AnythingMCP + CODEBOUND setup

CODEBOUND is already implemented inside this fork's NestJS backend, MCP server,
and Next.js frontend. It is **not** a second application or a plugin that you
copy into an upstream AnythingMCP image. The setup below provisions the original
application plus the isolated CODEBOUND Docker runner in the **same** host-run
backend. No official hackathon test kit, mock ERP, prebuilt scripts, cloud
model, or API subscription is required.

## Supported execution layout

- Linux or macOS; Windows users should run `bash setup.sh` from WSL2 with Docker
  Desktop configured for Linux containers (not `sh setup.sh` in PowerShell).
- Node.js **22.12+**, npm, OpenSSL, curl, Docker Engine/Desktop, Docker Compose v2.
- Backend (NestJS) and frontend (Next.js) run from this checkout on the host.
- The existing PostgreSQL service runs in Docker, listening on the **loopback**
  host address only. Existing volumes and credentials are retained.
- The backend uses the host Docker CLI/daemon as a **trusted supervisor** to
  create a disposable `codebound-sandbox:mvp` container per execution. The
  sandbox has no network, no host mounts, and tight CPU/memory/process limits.
  Do **not** mount the Docker socket into a web application or frontend
  container. Host daemon access itself is privileged; use a trusted dev machine.

The stock `docker-compose.yml` runs both frontend and backend in one application
container. That container has **no trusted supervisor access to Docker**.
Consequently, the Docker-only mode installs the CODEBOUND UI/API but **cannot
execute scripts** (returns `SANDBOX_UNAVAILABLE`). The installer makes this
explicit; it does not silently provide a dangerous Docker socket mount.
Production containerized execution requires an independently secured supervisor.

## Fresh machine

```bash
git clone https://github.com/KnightRider242/anythingmcp-BlackForestHackathon.git
cd anythingmcp-BlackForestHackathon
# Use the branch containing this installer until the PR is merged:
git switch feat/codebound-portable-setup

bash setup.sh
```

Select **2 — Local development + CODEBOUND** in the interactive wizard, keep
the suggested localhost ports or choose unused ports, and select the desired
MCP authentication (OAuth2 recommended for actual clients). On a fresh host,
the installer creates an owner-only root `.env`, starts PostgreSQL,
installs locked npm dependencies, deploys all existing Prisma migrations,
generates Prisma, and builds the separate sandbox Docker image.

Then launch the **integrated** app:

```bash
npm run codebound:dev
```

Open `http://localhost:3000/scripts` and
`http://localhost:3000/scripts/runs` (adjust the frontend port if configured).
The launcher propagates root `.env` into **both** npm workspaces, and
`BACKEND_INTERNAL_URL` points the Next.js proxy to the same NestJS instance
by default, avoiding the `DATABASE_URL` inheritance error.

Register the first admin, import/configure your own approved HTTPS REST
connectors and tool definitions, create a script with approved bindings, then
run it. Only eligible personal scripts become MCP tools at an authenticated
`/mcp/<serverId>`. Runs & Insights uses stored receipts.

## Add CODEBOUND to an existing local application

This preserves `.env`, JWT/encryption keys, users, connectors, and PostgreSQL
data. **Back up the database first when upgrading any real installation.**

```bash
git fetch origin
git switch feat/codebound-portable-setup
bash setup.sh --add-codebound
npm run codebound:dev
```

The `--add-codebound` path rejects a missing/production `.env`, a non-loopback
PostgreSQL URL (such as `postgres:5432` from a Docker-only installation), and
an inconsistent configured database port; it never resets a volume or invents
replacement credentials. Prisma `migrate deploy` is additive and may be
repeated. The Docker sandbox image is built from `deploy/codebound/Dockerfile`
and tagged `codebound-sandbox:mvp`.

To rebuild it after updating the sandbox implementation:

```bash
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
```

The earlier Black Forest test environment, with an isolated backend on port
4001, PostgreSQL on 5434, and secrets in `.env.codebound.local`, remains a
**separate** reproducible scenario documented in [QUICKSTART.md](QUICKSTART.md).
The portable setup does not read or modify that file and does not run the
official kit's `npm run setup`.

## Docker-only AnythingMCP (without working CODEBOUND execution)

`bash setup.sh` still offers Docker Compose deployment for the ordinary
AnythingMCP application. It builds **this fork**, tagged
`codebound-anythingmcp:local`, rather than overwriting
`helpcodeai/anythingmcp:latest`. CODEBOUND's editor, management API, and
receipt UI may be present, but no script execution works until a hardened
supervisor is designed and explicitly connected. Do not route production
traffic to this mode while implying CODEBOUND execution is available.

## Sanity checks and troubleshooting

```bash
bash -n setup.sh
bash -n scripts/setup-codebound.sh
node --check scripts/dev-codebound.mjs
docker info --format '{{.OSType}}'                # linux
docker image inspect codebound-sandbox:mvp
# In the running dev application:
curl -f http://localhost:4000/health
```

- `DATABASE_URL` missing: use `npm run codebound:dev`, not the bare
  `npm run dev`; the wrapper explicitly propagates root `.env`.
- PostgreSQL unavailable: check `docker compose -f docker-compose.yml -f
  docker-compose.dev.yml ps postgres` and confirm `POSTGRES_PORT` matches
  the port in `DATABASE_URL`.
- `SANDBOX_UNAVAILABLE`: check that the **host backend** can use
  `docker info`, the daemon uses Linux containers, and the sandbox image
  exists. The Docker-only app container is not a supported execution mode.
- No scripts in MCP: register an MCP server, attach connectors, save
  authorized bindings and authenticate as the script owner.
- Corporate or local HTTP REST endpoints are not generally permitted by
  CODEBOUND's gateway. Production tools must use HTTPS; the localhost HTTP
  mock exception from the hackathon kit is intentionally **not enabled**
  by the portable installer.

No test secrets, hard-coded OAuth tokens, privileged container mounts,
automatic scripts, or background services are added by this setup.
