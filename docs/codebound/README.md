# CODEBOUND sandbox milestone

The shared contracts live in `packages/backend/src/codebound/`. The sandbox
adapter is `sandbox/docker-sandbox-runner.ts`; it is not registered in NestJS
and exposes no HTTP/MCP endpoint. Persistence, real connector authorization,
UI and marketplace installation are separate delivery steps.

## Reproduce (PowerShell)

From the repository root, with Node >=22.12, locked dependencies installed,
and Docker Desktop using Linux containers:

```powershell
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
Set-Location packages/backend
$env:RUN_CODEBOUND_SANDBOX_LIVE='1'
npm test -- --runInBand codebound/contracts.spec.ts codebound/sandbox
npx tsc --noEmit --incremental false -p tsconfig.json
npx eslint src/codebound/sandbox/*.ts
Remove-Item Env:RUN_CODEBOUND_SANDBOX_LIVE
```

The live tests are opt-in. Once enabled, missing Docker/image is a test failure,
never a skip. They use a fake gateway and check cleanup after every test.
Ordinary `npm test -- --runInBand codebound/sandbox/docker-sandbox-runner.spec.ts`
runs supervisor boundary tests without Docker. No database is used by these tests.
The full backend typecheck requires the existing generated Prisma client;
generating it does not require schema changes or running migrations.

## Execution and trust

Source defines `async function main(input, api)`. The runner validates and copies
the request, then creates a uniquely named container without network or mounts.
Docker's automatically injected proxy settings are explicitly cleared in both
upper/lower case, so CLI proxy credentials are not passed into the container.
Only source, JSON input and bounded policy are sent over stdin. `api.read` uses
newline-delimited JSON on stdout/stdin; the trusted supervisor validates frames,
counts calls independently, and passes at most one operation to its callback.
The callback must be an authorized gateway in a future milestone. Never install
a fake gateway in a user-facing deployment. No existing connector cache is used.

The execution container runs as UID/GID 65534, with read-only root, no extra
capabilities, no privilege escalation, no shared IPC, no Docker logging, capped
file descriptors, processes, CPU and memory, and no swap growth. Docker's default
seccomp policy remains active. Before evaluating source, the container bootstrap
checks its UID, empty effective capabilities, no-new-privileges and active seccomp;
failure prevents the readiness handshake. A minimal native namespace PID 1 watchdog
owns a 15-second alarm and reaps children; the supervisor enforces the selected
deadline (at most ten seconds). PID 1 cannot be stopped by a script's SIGSTOP, and
is marked non-dumpable to protect its memory from same-user script processes.
The compiler exists only in the image build stage. Docker `--init` must not wrap
this watchdog: the watchdog must itself be PID 1. A live regression kills the
Docker attach client and verifies termination without a host-side execution timer.
Every path attempts force-removal. Unconfirmed cleanup disables that runner
instance and returns `SANDBOX_UNAVAILABLE`, including after an otherwise valid result.

stderr contents are discarded; only byte counts are retained. stdout is protocol,
not free-form logs. Malformed protocol is fatal, and incomplete/oversized frames
cannot become successful output. Errors use fixed messages without script stack
traces, Docker diagnostics or callback exception text. Outputs and gateway replies
are validated using shared validators, including selected lower byte caps.

## Security limits and deployment behavior

The same adapter and mandatory limits apply in Cloud and self-hosted modes.
Missing Docker, Linux isolation or the prebuilt image fails closed. This milestone
does not wire either deployment to Docker: invoke it only from a trusted supervisor
with Docker authority, not by mounting the Docker socket into the application.
Existing deployment/license checks and live per-operation authorization must be
preserved by future integration. A single connector call makes no streaming,
pagination or full-dataset completeness guarantee.

Containers share a kernel and are not proof against kernel/runtime vulnerabilities.
Scripts can read files baked into their minimal image and use built-in Node APIs;
the container boundary, not a JavaScript VM, supplies isolation. Image/daemon
configuration and supported cgroup/seccomp enforcement are prerequisites. The
supervisor has privileged Docker authority and must remain trusted and separated
from application tenants. There is no fleet-wide admission control in this milestone.

If the supervisor crashes, the PID 1 watchdog stops script execution, but the
stopped container may require removal. If the daemon is unreachable, removal cannot
be guaranteed: the adapter reports failure and disables itself. A production
supervisor restart/reconciliation policy is still needed. A pending fake callback
cannot be force-cancelled by this interface; real gateway integration must bind
upstream cancellation to the execution signal/deadline. Late replies are ignored.
Shared validators establish plain JSON and size, not conformity to a saved output
schema: this runner receives no saved schema in its approved contract.

Marketplace-installed scripts remain in project scope. Owner-only execution is an
MVP authorization restriction, not the final marketplace ownership model.
