# CODEBOUND execution — Milestone 4 Phase B

`POST /api/codebound/scripts/execute` executes an existing personal script. The
body is `{ "scriptId": "...", "expectedRevision": 1, "input": {} }`. The existing
dashboard JWT guard supplies the caller and live active organization; the
controller reuses `AuthService.verifyToken` for verified issue/expiry timestamps.
Identity, binding, source, limits and credentials are never accepted in this body.
MCP OAuth tokens are rejected by the existing dashboard strategy.

`CodeboundExecutionModule` is registered in `AppModule`. Its execution service:

1. Validates/copies bounded JSON and admits at most two runs per process and one
   per organization/owner pair. There is no queue or automatic retry/replay.
2. Recovers this authenticated owner's stale receipts, then uses
   `ScriptPersistenceService.beginExecution` to atomically capture the expected
   revision and create RUNNING. A mismatch creates no receipt.
3. Opens `AuthorizedConnectorGatewayService` with a deadline and cache bypass.
   Live authorization checks include ownership, membership, token revocation,
   roles (including the existing distinction between null and []), enabled
   state and exact binding fingerprint. MCP-origin service principals also
   retain the gateway's server/grant checks; this HTTP route is dashboard-only.
4. Sends only source, input, execution ID and fixed `MVP_LIMITS` to
   `DockerSandboxRunner`. Source defines `async function main(input, api)`.
   The container has no network, mounts, Docker socket or connector secrets.
5. Routes at most one `api.read(arguments)` through the live-authorized gateway
   and restricted HTTPS GET executor. Credentials are decrypted in the backend
   and attached only to that HTTPS operation. Intermediate JSON stays outside
   the model. This establishes no pagination, streaming or dataset completeness.
6. Closes the session, awaits runner cleanup, validates at most 16 KiB output
   and finalizes the immutable receipt. Only metrics and fixed error information
   are stored; source/input/output/raw connector responses are not receipt fields.

Successful admission returns HTTP 200 with `Outcome<ScriptExecutionResult>`:
`{ok:true,value:{executionId,scriptId,revision,sourceSha256,metrics,status,...}}`.
`status` is succeeded (with output), failed or cancelled (with sanitized error).
Clients must inspect status; HTTP 200 alone does not mean script success.
Before a receipt exists, invalid input/not-found/forbidden/revision conflict/
capacity return 400/404/403/409/503 with `{ok:false,error}`. Existing JWT failures
use the application's 401 response. Receipt-write failure returns a sanitized
500 without claiming success or returning output. HTTP disconnect and application
shutdown abort active runs. An uncertain runner/cleanup failure remains
SANDBOX_UNAVAILABLE rather than being masked by a deadline/cancellation.

## Receipts, recovery and audit

`beginExecution` returns a backend-only finalization closure bound to the exact
created receipt, owner and organization. It can make only the existing RUNNING
to terminal compare-and-swap transition, using the existing bounded completion
validator and PostgreSQL trigger. It deliberately does not require still-live
membership: revocation removes execution authority, not the ability to record
its termination. There is no public unauthenticated finalization operation.

Hard crashes cannot synchronously finalize receipts. On the owner's next
authenticated execution, RUNNING receipts older than **five minutes**, measured
by PostgreSQL, are marked CANCELLED with zero/previously known metrics; unknown
work is never replayed. Recovery is organization/owner/caller scoped, does not
affect recent runs on other replicas, and is not a global periodic sweeper.
Without a later execution they remain RUNNING. Database outages can likewise
leave RUNNING receipts. The existing container PID 1 watchdog stops code after
15 seconds even if the supervisor dies, but an exited orphan container may
remain after a hard host/process failure. Receipt recovery does not claim to
remove that orphan. See [sandbox limitations](SANDBOX.md).

Each gateway call uses `AuditService.logInvocation` with execution ID,
organization, caller, tool/connector, duration and status. No call arguments,
source, input or output are passed to audit. CODEBOUND opts out of repeat-error
coalescing so distinct runs stay attributable. The existing audit writer is
**best effort**, not transactional with the receipt. The supervisor waits at
most two seconds for audit after fixing the execution outcome; audit never delays
connector IPC or consumes the script's execution deadline. A late DB write may finish afterwards. Audit outages
can lose invocation rows. Calls rejected before a session opens have a failed
receipt but no connector invocation row. PostgreSQL authorization queries and
audit writes cannot currently be interrupted; gateway cancellation prevents
late authorization/DNS completion from dispatching HTTP. An HTTPS request in
flight is aborted, but revocation cannot recall data already fetched.

## Reproduce the full demo locally (PowerShell)

From the repository root, after the normal locked-dependency setup, with Docker
in Linux-container mode. Use only a disposable database for these fixture tests:

```powershell
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
docker run --rm -d --name codebound-execution-test -e POSTGRES_PASSWORD=codebound-test-only -e POSTGRES_DB=codebound_test -p 127.0.0.1:55520:5432 postgres:17-alpine
Set-Location packages/backend
$env:DATABASE_URL='postgresql://postgres:codebound-test-only@127.0.0.1:55520/codebound_test'
npx prisma migrate deploy
npx prisma validate
npx prisma generate
$env:CODEBOUND_TEST_DATABASE_URL=$env:DATABASE_URL
$env:RUN_CODEBOUND_EXECUTION_LIVE='1'
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path src/codebound/gateway/fixtures/localhost.cert.pem).Path
npm test -- --runInBand --silent --runTestsByPath src/codebound/execution/script-execution.integration.spec.ts src/codebound/persistence/script-persistence.integration.spec.ts src/codebound/persistence/script-migration.integration.spec.ts
Remove-Item Env:NODE_EXTRA_CA_CERTS,Env:RUN_CODEBOUND_EXECUTION_LIVE,Env:CODEBOUND_TEST_DATABASE_URL
docker stop codebound-execution-test
```

The fixture creates actual users, memberships, connector, encrypted credential
and saved script in PostgreSQL; starts a real controlled HTTPS server; signs a
dashboard JWT; calls a real Nest HTTP endpoint; executes in Docker; and asserts
compact `{ "total": 11 }`, terminal receipt, audit metadata and container removal.
The gateway, roles, membership queries, encryption/decryption, transport, Docker
runner and JWT strategy are real, with **no transport/gateway/runner mocks**.
The fixture allows localhost only for its HTTPS server and trusts its public test
certificate via Node's extra CA mechanism. Do not use that trust/allowlist in a
deployment. The isolated container still has networking disabled. The test Nest
application uses the real controller/services. A separate smoke test below boots
the actual compiled AppModule with no provider overrides, including its global
guards. It does not establish Cloud billing or optional audit hook coverage.
Missing Docker/image/database/CA configuration fails the enabled suite.

The focused unit suite mocks the persistence, runner and gateway explicitly:

```powershell
npm test -- --runInBand --silent --runTestsByPath src/codebound/execution/script-execution.service.spec.ts src/codebound/execution/script-execution.controller.spec.ts src/codebound/persistence/script-persistence.service.spec.ts src/codebound/gateway/gateway.spec.ts
npx tsc --noEmit -p tsconfig.json
npm run lint:check
npm run build
```

The actual application smoke test runs the compiled AppModule under Node (Jest's
CJS loader on Node 22 cannot load the existing ESM `openid-client` dependency).
It resolves all execution providers, starts HTTP with the normal global guards
and validation, verifies 401/404/400 responses and checks that live JWT organization
scope takes precedence over a stale organization claim. Build first and keep the
disposable migrated database running. Use these **public fixture secrets only for
this disposable test process**, never for a deployment:

```powershell
$env:DATABASE_URL='postgresql://postgres:codebound-test-only@127.0.0.1:55520/codebound_test'
$env:CODEBOUND_TEST_DATABASE_URL=$env:DATABASE_URL
$env:RUN_CODEBOUND_APP_LIVE='1'
$env:DEPLOYMENT_MODE='self-hosted'
$env:MCP_AUTH_MODE='none'
$env:REDIS_URL=''
$env:JWT_SECRET='codebound-app-review-public-test-secret'
$env:ENCRYPTION_KEY='codebound-app-review-public-test-key'
$env:NODE_ENV='test'
npm test -- --runInBand --silent --runTestsByPath src/codebound/execution/app-wiring.integration.spec.ts
```

The focused final review additionally covers slow/rejected audit writes,
disconnects occurring during authentication, immutable finalizer scope after
principal mutation/revocation, and concurrent terminal transitions. Recovery is
still lazy, and audit remains best effort as described above.

With a normally running backend and a script already saved through the Phase A
service, an existing dashboard token can execute it as follows (supply your own
`$token` and `$scriptId`; no new script creation HTTP endpoint is added):

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:4000/api/codebound/scripts/execute' -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body (@{scriptId=$scriptId; expectedRevision=1; input=@{}} | ConvertTo-Json)
```

Linux/macOS use the same image and commands with shell environment syntax, e.g.
`CODEBOUND_TEST_DATABASE_URL=... RUN_CODEBOUND_EXECUTION_LIVE=1 NODE_EXTRA_CA_CERTS="$PWD/src/codebound/gateway/fixtures/localhost.cert.pem" npm test -- --runInBand codebound/execution/script-execution.integration.spec.ts`
from `packages/backend`, after migrating the disposable DB. Windows Docker
Desktop/Linux containers were exercised; native Linux and macOS/arm64 execution
are not independently verified here.

## Deployment and remaining boundaries

Cloud and self-hosted use the same contracts, endpoint, owner restriction,
existing authentication and gateway deployment/license policy. Both require
an available isolated Linux Docker runner and image; otherwise execution fails
closed. The execution container never receives the daemon socket. The backend
supervisor does require Docker access; that trust boundary and container/kernel
escape risk remain. No new runtime, queue, database or deployment-mode switch
is introduced. Capacity admission is per process, not a distributed quota.

This phase adds no schema migration, persistence CRUD HTTP API, frontend,
marketplace install or MCP registration. Saved JSON schema documents are still
shape/size validated only: arbitrary JSON Schema semantics and output matching
those schemas remain unimplemented, as in the shared contract MVP. Output and
IPC are nevertheless strictly bounded safe JSON. Marketplace scripts remain in
delivery scope after this end-to-end slice; owner-only access is temporary.
