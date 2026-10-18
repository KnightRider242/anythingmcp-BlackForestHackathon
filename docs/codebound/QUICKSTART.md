# CODEBOUND — build, run, verify and demo

**Black Forest Hackathon 2026 · Secure script workflows for AnythingMCP**

This is the current setup guide for the CODEBOUND implementation in this fork. The older [architecture guide](README.md) contains historical one-call MVP notes; the current code supports multi-tool F2–F4 scripts.

## The idea

AnythingMCP turns business APIs into MCP tools. CODEBOUND additionally lets authorized users save **typed, versioned JavaScript workflows** as new MCP tools. A script can page through ERP records, join supplier or carrier data, filter and return a compact result without sending all intermediate datasets through an AI model.

The code executes in **ephemeral Linux Docker sandboxes** with no direct network, no host secrets, a read-only root and a private 8 MiB /tmp. A trusted gateway checks workspace, current permissions, approved tool bindings and execution budgets on **every** connector call. Script outputs and execution receipts are bounded.

### Functionality verified by the official kit

| Card | Workflow | Verified result |
| --- | --- | --- |
| P1/P2 | Processor chain: price conversion, VAT, normalization and invalid-field failure | PASS |
| F1 | Three discoverable MCP script tools with typed inputs | PASS |
| F2 | `price_drift_check`: ERP articles + batched Supplier POST | 4 rows for threshold 5, 2 for 10 |
| F3 | `catalogue_total`: supplier pagination with truthful partial failure | fasteners 800/true, adhesives 137/true, legacy 200/false |
| F4 | `stuck_orders`: shipped ERP orders joined to Carrier scans | 5 rows for 3 days, 2 for 7 days (kit reference date) |
| S1/S2/S3 | No official connector canaries in output, configured backend logs or configured database scan | 3/3 PASS |
| A1–A11 | Live security attacks, including cross-workspace tools, host/network escape, temp isolation, limits and denial auditing | PASS in team verification |
| F5/A13 | Optional injected-secret workflow | Not implemented |
| A12 | Cloud Host scripting | Not applicable to tested self-hosted mode |

**Total: 6/6 mandatory checks and 3/3 official secret scans.** The full kit command may exit 1 because the optional F5 is absent; do not describe it as an all-green test run. See [F2–F4 implementation evidence](F234_IMPLEMENTATION_REPORT.md) and [A1–A13 attack-card report](ATTACK_CARD_VERIFICATION_REPORT.md) for exact scope and limitations.

## Architecture at a glance

```text
Authenticated UI / MCP client
    -> saved revision + typed input
    -> CODEBOUND lifecycle (NestJS, PostgreSQL, receipt)
    -> trusted connector gateway (workspace, role, tool, grant)
    -> ephemeral Docker JavaScript sandbox (no direct network)
    -> gateway-mediated ERP / Supplier / Carrier tool calls
    -> bounded result and audit
```

Main implementation: `packages/backend/src/codebound/`. Management UI: `packages/frontend/`. Sandbox image: `deploy/codebound/Dockerfile`. Reproducible workflows: `scripts/codebound-kit-workflows.mjs`. Execution and verifier: `scripts/codebound-local.mjs` and `scripts/verify-codebound-f234-attacks.mjs`.

## Requirements

- Node.js **22.12+**, npm **9+**, Git.
- Docker Engine or Docker Desktop in **Linux containers** mode; Docker Compose.
- PostgreSQL for actual runtime; build-only steps below do not require a live database.
- For an end-to-end test, the separate official [CODEBOUND challenge kit](https://github.com/HelpCode-ai/codebound-kit), which provides test workspaces, mock ERP/Supplier/Carrier/Payroll, and the official acceptance checker.
- No model API key is needed for CODEBOUND's deterministic JavaScript workflows.

## 1. Clean Linux build — no secrets or running services

The hackathon build evaluator checks out the repository and tries the root `docker-compose.yml` first. The following command **builds** the upstream-style combined AnythingMCP app image; it does *not* start it or prove that the secure CODEBOUND sandbox is wired into that production container.

```bash
git clone https://github.com/KnightRider242/anythingmcp-BlackForestHackathon.git
cd anythingmcp-BlackForestHackathon
docker compose -f docker-compose.yml build app

# Build the separate sandbox image as well:
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
```

The root Dockerfile sets a **dummy DATABASE_URL** for Prisma generation and skips Sentry source-map uploads when no token is supplied. Neither image build requires a real PostgreSQL server or application secrets. These commands are intended to be reproducible on Linux; a clean judge-host build has not been independently certified.

**Alternative Node/npm compilation**, from repository root:

```bash
npm ci
export DATABASE_URL=postgresql://build:build@localhost:5432/build_only
npm run build:backend
npm run build:frontend
```

The placeholder URL is for Prisma code generation **only**. Do not migrate or start the backend using it. The backend prebuild regenerates its adapter catalogue, so inspect `git status` after local builds. Avoid root `npm test`: the frontend workspace has no test script. For backend lint use `npm run lint:check --workspace=packages/backend`, not the autofixing `npm run lint`.

**Deployment boundary:** The root `Dockerfile` and `docker-compose.yml` are the original AnythingMCP application build/deployment, not a certified standalone CODEBOUND deployment. The tested CODEBOUND supervisor is a **trusted host backend** with controlled access to Docker CLI. Never mount a privileged host Docker socket into an untrusted/general app container as a shortcut.

## 2. Full CODEBOUND demo — existing isolated test environment

The verified configuration uses **separate** services:

| Component | Address / configuration |
| --- | --- |
| Original AnythingMCP (do not touch) | app `localhost:4000`, database port `5433` |
| CODEBOUND NestJS host backend | `http://localhost:4001` |
| Isolated CODEBOUND PostgreSQL | `localhost:5434/codeboundkit`, container `codebound-kit-db` |
| Official kit mocks | ERP 4101, Supplier 4102, Carrier 4103, Payroll 4104 |
| Mock/admin evidence | 4180/4181; outside service 4199 must remain unreachable by scripts |

**If this working database/kit is already provisioned, do not rerun setup or reset it.** Keep its existing JWT/encryption keys and private `.codebound/state.json` intact.

### A. First-time only: official kit provisioning

Clone the [official kit](https://github.com/HelpCode-ai/codebound-kit) alongside this fork. The kit requires a **new empty database** for `npm run setup`. First start its mocks, configure a separate localhost:5434 PostgreSQL database and this fork's host backend on 4001, then from the kit directory run:

```bash
npm run mocks
npm run setup -- --url http://localhost:4001 --mode host
```

This creates the Alpha/Beta workspaces, users, MCP keys and mock tool registrations and writes **sensitive** test state to `codebound-kit/.codebound/state.json`. The official kit has no npm dependencies to install. Configure a **private** `codebound.team.json` from `codebound.team.example.json` with the actual host-backend UTF-8 log file and the correct test PostgreSQL container/database, otherwise S2/S3 coverage may be misleading. **Do not modify the official checker, mocks or reference data.**

### B. Existing local configuration for backend build/start

At this fork's root, create a **gitignored** `.env.codebound.local` with the already established test secrets. Example of required keys (these placeholders are *not* credentials):

```dotenv
NODE_ENV=development
PORT=4001
DATABASE_URL=postgresql://amcp:REPLACE_LOCAL_PASSWORD@localhost:5434/codeboundkit
JWT_SECRET=REPLACE_WITH_EXISTING_SECRET
ENCRYPTION_KEY=REPLACE_WITH_EXISTING_ENCRYPTION_KEY
SSRF_ALLOWED_HOSTS=localhost
CODEBOUND_TEST_HTTP_ORIGINS=http://localhost:4101,http://localhost:4102,http://localhost:4103,http://localhost:4104
```

The dedicated build and migration launchers reject unexpected database or backend ports. The test-only HTTP exception works **only** in development/test, self-hosted mode and for the four explicitly listed localhost mock origins. Production connectors require HTTPS. Preserve existing secrets; never regenerate them for a working setup.

### C. Build and start (Windows PowerShell)

From the fork root, with the guarded database/mocks running:

```powershell
cd E:\Projs\anythingmcp-BlackForestHackathon
npm ci
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
node scripts/migrate-codebound-local.mjs
npm run codebound:build
npm run codebound:start
```

Keep the server terminal open. `npm run codebound:start` builds before running `packages/backend/dist/src/main.js` and passes variables from the ignored local env file to Prisma/Nest child processes; this avoids the Windows `DATABASE_URL` inheritance issue seen with other launch approaches.

If your kit's `codebound.team.json` specifies a UTF-8 backend log file for S2, launch with the same log file (instead of launching a second server):

```powershell
npm run codebound:start -- --log E:/Projs/codebound-kit/.codebound/f234-backend.log
```

**A prepared test environment should skip `npm ci`, migrations and reinstall steps if unchanged.** Never reset the original app or either database just to demonstrate CODEBOUND.

### D. Install the three demo workflows (after initial official setup only)

From this fork's root, in a *second* terminal:

```powershell
$state = "E:\Projs\codebound-kit\.codebound\state.json"
node scripts/configure-codebound-kit-processors.mjs $state
node scripts/install-codebound-kit-f1.mjs $state
node scripts/install-codebound-kit-f234.mjs $state
```

The F1 step installs typed placeholder scripts only when absent; the F2–F4 step upgrades the three saved scripts through revision-aware authenticated APIs. Re-running the latter without any changes prints `Unchanged`. It must never target the original port-4000 AnythingMCP system.

## 3. Run official acceptance and security verification

From the **kit root**:

```powershell
cd E:\Projs\codebound-kit
npm run check -- --card F1
npm run check -- --card F2
npm run check -- --card F3
npm run check -- --card F4
npm run check -- --only must
npm run check
```

Expected **recorded** live result: Must 6/6, secret scans 3/3; F5 (optional) remains absent. Full checker exit code may be 1 for that reason.

From the **fork root** (isolated setup only):

```powershell
node scripts/verify-codebound-f234-attacks.mjs E:\Projs\codebound-kit\.codebound\state.json
node --test scripts/verify-codebound-f234-attacks.test.mjs
```

The verifier creates and removes temporary scripts; it requires the live isolated kit and checks S2 after each card. Documented results: A1–A11 pass live, 57 focused tests, 23 real Docker tests and 15 verifier tests pass. The larger backend Jest suite retains three unchanged image/DNS test failures detailed in the [implementation report](F234_IMPLEMENTATION_REPORT.md); **do not claim the entire suite is green**.

Opt-in Docker regression tests from `packages/backend`:

```bash
RUN_CODEBOUND_SANDBOX_LIVE=1 npm test -- --runInBand --testPathPatterns='codebound|adapters/catalog' --silent
```

For compilation and lint verification on a configured checkout:

```bash
npm run build:backend
npm run lint:check --workspace=packages/backend
cd packages/backend && npx tsc --noEmit -p tsconfig.json
```

## 4. Two-minute live MCP demo

1. Keep the port-4001 backend, port-5434 database, Docker and official mock services running.
2. Connect an authenticated, **authorized Alpha** MCP client to `http://localhost:4001/mcp/<serverId>`. Credentials/server ID come from the **private kit state**, never from the README.
3. Call `tools/list`. Find the three saved tools named like `codebound_script_<hash>_price_drift_check`, `codebound_script_<hash>_catalogue_total` and `codebound_script_<hash>_stuck_orders`.
4. Invoke price drift with `{"threshold":5}` and `{"threshold":10}`. Show four then two rows.
5. Invoke catalogue with `{"category":"fasteners"}` then `{"category":"legacy"}`. Show `complete:true` versus `complete:false`.
6. Optionally show Carol's restricted Payroll call denied and correctly audited. Avoid exposing keys, raw secrets or unredacted private logs.
7. Keep the checker results and [attack report](ATTACK_CARD_VERIFICATION_REPORT.md) available as backup evidence.

## Troubleshooting

- **`EADDRINUSE :4001`**: a CODEBOUND backend may already be running. Inspect the listener and reuse it, or restart **only** that verified process. Never stop the original port-4000 app.
- **Prisma `DATABASE_URL` not found**: use `npm run codebound:build` or `npm run codebound:start` with the ignored root `.env.codebound.local` rather than calling Prisma/Nest without exported variables.
- **`SANDBOX_UNAVAILABLE`**: check Docker daemon, Linux container mode, the `codebound-sandbox:mvp` image and cleanup/resource limits; no unsafe host-eval fallback exists.
- **F2–F4 connector errors**: check kit mocks, authorized bindings and that the F2–F4 installer upgraded the F1 placeholders.
- **All mandatory checks pass but `npm run check` exits 1**: optional F5 is not implemented.
- **Keep secrets private**: never commit `.env` files, `.codebound/state.json`, backend logs, database dumps, mock credentials or raw attack evidence. The checker scans specified canaries, not all conceivable secrets. Existing plaintext MCP API-key storage remains a documented limitation.

### More detail / attribution

Read [architecture](README.md), [execution](EXECUTION.md), [MCP integration](MCP.md), [sandbox](SANDBOX.md), [marketplace](MARKETPLACE.md), [implementation report](F234_IMPLEMENTATION_REPORT.md), and [live security verification](ATTACK_CARD_VERIFICATION_REPORT.md).

Built on the upstream [HelpCode-ai/anythingmcp](https://github.com/HelpCode-ai/anythingmcp) (AGPL-3.0-only). The official [HelpCode-ai/codebound-kit](https://github.com/HelpCode-ai/codebound-kit) is a separate, unchanged test harness.
