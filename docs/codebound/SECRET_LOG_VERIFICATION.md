# CODEBOUND credential-log verification

Verified on `feat/codebound-lifecycle`, 17–18 October 2026. The demonstrated S2
request-logging leak is fixed. The requested fully passing functional suite is
**not achieved**: this branch implements a one-call MVP, F2–F4 are unfinished,
and F5/secret injection is absent.

## Test bed and baseline

The existing kit state points at a host backend on port 4001 and the local
configuration uses database `codeboundkit` on port 5434. Initially there was no
`codebound.team.json`. For that host state the checker defaults to no log source
(S2 skips) and `amcp-postgres/anythingmcp` for S3, which is not that database.
The earlier S2/S3 status therefore cannot establish coverage of that instance.

A separate `codebound-verify-postgres` container was created, published only on
localhost:5435. Existing databases/volumes were preserved. Original kit state is
backed up as `.codebound/original-state-before-verification.json`; default state
now points at the verified Docker fixture. Existing migrations, official setup,
the existing processor
configuration and F1 fixtures were applied. The compiled fork runs on port 4002.
The official kit has no dependencies; no `npm install` was run in it.

The kit artifacts below are relative to `E:/Projs/codebound-kit` and are private,
gitignored files. They contain credentials or intentionally vulnerable baseline
logs and must not be committed.

| Check | Before code changes, host | Fixed host | Fixed Docker API |
| --- | --- | --- | --- |
| P1 | PASS | PASS | PASS |
| P2 | PASS | PASS | PASS |
| F1 | PASS | PASS | PASS |
| F2 | FAIL | FAIL, connector error | FAIL, sandbox unavailable |
| F3 | FAIL | FAIL, connector error | FAIL, sandbox unavailable |
| F4 | FAIL | FAIL, connector error | FAIL, sandbox unavailable |
| F5 | MISSING | MISSING | MISSING |
| S1 | PASS, 9 outputs | PASS, 9 outputs | PASS, 9 outputs |
| S2, functional run | PASS | PASS | PASS |
| S2, after credential-bearing HTTP probes | **FAIL** | **PASS** | **PASS**, whole-log supplement |
| S3 | PASS | PASS | PASS |

Full baseline output: `.codebound/verify-host/baseline.log` and `baseline.json`.
The failing S2 reproduction is `s2-before.log`/`s2-before.json` in that directory.
Fixed host output: `.codebound/verify-final/final.log` and `final.json`.
Final Docker output: `.codebound/verify-docker/final.log` and `final.json`.
Explicit Must/F5 results: `must.log`/`must.json`, `f5.log`/`f5.json` there.
Must remains 3/6; Should remains 0/1; official secret scans are 3/3.

F2–F4 fixtures are documented as first-page F1 examples. In addition,
`src/codebound/gateway/bound-rest-executor.service.ts:77` requires HTTPS, whereas
the official mocks use HTTP. Removing that check would still not implement the
required pagination and joins: `contracts.ts` and the gateway allow one call and
one bound tool. No security limits or checker expectations were weakened.

The Docker backend is healthy, but its image has no Docker CLI (`ENOENT`).
F2–F4 therefore fail earlier with `SANDBOX_UNAVAILABLE` in Docker. No untrusted
script runs there. The real worker attacks below ran on the compiled host
backend, with Docker authority available to its trusted supervisor. This
deployment gap is consistent with the boundary documented in `SANDBOX.md:86`.

## Root cause and changes

The live pre-fix reproduction sends a workspace supplier canary as a URL path,
query value, custom header, request ID and correlation ID. The existing Pino
redaction paths removed named auth headers but retained the URL, other headers
and caller-selected IDs. The official S2 checker then reported the supplier
credential in backend logs. Base64 and hex forms were also found by a separate
scan; the canary uses URL-safe characters, so its normal URI encoding is unchanged.

Targeted changes, all under the AGPL part of the repository. Source paths below
are relative to `packages/backend`:

- `src/common/logger.module.ts:29`: always generate the request ID; return it
  in `X-Request-Id`. Caller IDs no longer round-trip. HTTP serializers allow
  only ID, method and status; error payloads, URLs and headers are omitted.
  Existing named-field redaction remains as defense in depth.
- `src/connectors/engines/rest.engine.ts:478` and `:665`: remove resolved URLs
  and arbitrary error details from dispatch and exhausted-retry logs. Credentials
  can appear in paths, not just auth headers or query strings.
- `src/mcp-server/mcp-endpoint.controller.ts:1249`: replace raw SDK/adapter error
  text in request-handling logs with fixed messages; do not log a caller-selected
  session ID on routing failure. Server context is retained where available.
- `src/auth/mcp-combined-auth.guard.ts:144` and `src/auth/email-verified.guard.ts:87`:
  omit caller-controlled request paths and unknown subjects from refusal logs.
  Authorization acceptance/refusal behavior is unchanged; regression assertions
  cover revoked/unknown tokens and unverified Cloud users.
- `src/common/prisma.service.ts:80` and `src/audit/audit.service.ts:173`: omit
  database exception text, which can include SQL arguments and stored inputs.
- `src/common/crypto/env-vars-at-rest.ts:74`: omit crypto/JSON exception text,
  which can quote malformed decrypted content.
- Regression tests exercise the actual Pino HTTP pipeline, credential-bearing
  retry URLs, primary/retry audit failures, reconciliation failures and malformed
  decrypted JSON. The logger probe changes from four encoding matches to none.

The log policy applies unconditionally in both Cloud and self-hosted modes.
Cloud deployment was not run separately; its email-guard log branch was unit
tested. There are no `ee/`, schema or authentication-policy changes.

## Logging-path audit

The CODEBOUND executor logs generated execution IDs and fixed cleanup/audit
messages only; invocation audits contain metadata rather than script source,
input, output or injected configuration. The gateway catches connector failures
and returns fixed errors. `BoundRestExecutor` does not log request headers or
response bodies, and rejects recognized credential echoes before returning data.
The runner discards worker stderr, treats stdout as bounded IPC, and maps invalid
frames/worker exceptions to fixed errors. Disposable workers use Docker log
driver `none`. The existing sandbox image's `runner.cjs` SHA-256 matched the
checked-out worker: `627dc9abdf1e4ecb374add4c0caaff39929f549a59b674a0b8e70dab3ae28d31`.
Prisma query logging is not configured in `PrismaService`.

## Attack results

The runnable harness and outcomes are `.codebound/verify-final/attacks.mjs`,
`attacks.log` and `attacks.json`. Each card first makes an ERP nonce call through
the real MCP gateway as bob; it then creates, executes and deletes a disposable
ERP-bound script. The nonce is a harness preflight, not an additional script
capability. Each attack is followed by the **unmodified official S2 check**;
all six scans pass.

| Card/probe | Observed outcome |
| --- | --- |
| A3 | No `env`, no `api.env`, no supplier variable |
| A5 | Outside by Docker hostname and localhost, and the unbound carrier, all blocked; Outside received zero requests |
| A6 | Host canary variable absent; host canary file absent |
| A13 adaptation: throw secret-bearing headers | Fixed `SCRIPT_ERROR`; no credential in response/logs |
| A13 adaptation: log env/headers and write a canary to stderr | Successful receipt; contents discarded; no credential in response/logs |
| A13 adaptation: log env/headers to stdout | Fixed `SCRIPT_ERROR` for invalid IPC; no credential in response/logs |

Canaries for the A13 adaptations are supplied as runtime inputs, including
`Authorization: Bearer ...` and `X-Api-Key`. F5 does not exist, so these are **not**
verification of an injected-secret API or successful masking of returned secrets.
Other attack cards were not exercised in this run. A separate live HTTP probe
replays the original S2 failure after the fix; S2 passes.

## Commands and validation

The fork was built and started from the repository root using:

```powershell
docker compose --env-file .env.codebound.verify.local -f docker-compose.yml -f E:/Projs/codebound-kit/compose/anythingmcp.override.yml -f E:/Projs/codebound-kit/.codebound/api.override.yml up -d --build
```

The extra private override selects the existing Dockerfile's `backend-builder`
target, runs its compiled API, enables debug logging, and uses a Node healthcheck.
It does not add capabilities to the sandbox. The unified frontend image was not
completed; its original build was interrupted after the slow dependency stages
finished. The backend-target image built successfully from the current source.
This is a test image, not validation of the hardened unified production image.
Random JWT/encryption/database secrets are in the gitignored
`.env.codebound.verify.local`; the user's existing `.env` was not changed.

Docker-mode setup, from `E:/Projs/codebound-kit`, on the empty database:

```powershell
$env:CODEBOUND_STATE_DIR='.codebound/verify-docker'
npm run setup -- --url http://localhost:4000 --mode docker --app-container codebound-verify-app
```

Final checks from the kit, with the Docker backend running:

```powershell
$env:CODEBOUND_STATE_DIR='.codebound/verify-docker'
npm run check -- --json .codebound/verify-docker/final.json
npm run check -- --only must --json .codebound/verify-docker/must.json
npm run check -- --card F5 --json .codebound/verify-docker/f5.json
npm run check -- --card S2 --json .codebound/verify-docker/s2-http-probe.json
```

The full and Must commands exit **1** because of the F2–F4 baseline failures;
F5 exits **1** because the tool is absent. S2 exits **0**. The API is stopped
after verification, so restart it with the Compose command above before checking
again. Only `codebound-verify-app` and `codebound-verify-postgres` were stopped;
their logs and database volume remain. The kit's tracked files/checker/expected
results are unchanged (`git status --short` is clean).

`codebound.team.json` explicitly names `codebound-verify-app` and
`codebound-verify-postgres`, database `anythingmcp`, user `amcp`. Host verification
used its complete combined stdout/stderr file in a separate team configuration. Baseline used
`CODEBOUND_STATE_DIR=.codebound/verify-host` and its saved `team.json` via `--team`.
Before the fixed-code run, only this task's disposable database was dropped and
recreated, migrations reapplied, and setup run on the empty database. No Docker
volumes were deleted. Functional checks and probes read immutable mock data;
disposable attack scripts are removed after execution.

The host baseline setup command was `npm run setup -- --url http://localhost:4002
--mode host`, with `CODEBOUND_STATE_DIR=.codebound/verify-host`. Its full baseline
command was `npm run check -- --team .codebound/verify-host/team.json --json
.codebound/verify-host/baseline.json` (exit **1**, functional gaps shown above).
`npm run cards` was run and its output saved. Existing processor/F1 helper scripts
were used; private copies changed only their isolated-port guards for ports 4002
and 4000. No checker or expected-result logic was edited.

From `E:/Projs/anythingmcp-BlackForestHackathon/packages/backend`:

- `npm test -- --runInBand --runTestsByPath src/common/logger.module.spec.ts src/common/prisma.service.spec.ts src/common/crypto/env-vars-at-rest.spec.ts src/audit/audit.service.spec.ts src/connectors/engines/rest.engine.spec.ts src/mcp-server/mcp-endpoint.controller.spec.ts`:
  **6 suites, 184 tests pass**.
- `npm test -- --runInBand --runTestsByPath src/auth/mcp-combined-auth.guard.spec.ts src/auth/email-verified.guard.spec.ts`:
  **2 suites, 31 tests pass**.
- `npx tsc --noEmit -p tsconfig.json`: **pass**.
- `npm run lint:check`: **pass, 14 warnings**. Used the non-mutating lint command
  to avoid incidental rewrites, especially under `ee/`.

From the repository root, `node scripts/validate-adapters.mjs --warn`:
**490 pass, 0 fail, 1458 warnings**, identical to the captured baseline.
The default `npm test -- --runInBand` run encountered five-second timeouts in
untouched `common/ssrf.util.spec.ts` and `database.engine.ssrf.spec.ts`, then
stalled near 3.7 GB of memory and was interrupted. Those two suites passed
unchanged with `--testTimeout=30000` (**36 tests**). A subsequent full run with
512 MB worker recycling was also interrupted because TypeScript's initial
working set exceeded that threshold. Neither interrupted run is reported as a
pass. Full runtime assertions are run separately with a private isolated-transpile
Jest configuration; repository Jest configuration and assertions are unchanged.

Full runtime command (same backend working directory):

```powershell
npm test -- --config E:/Projs/codebound-kit/.codebound/jest-runtime.config.cjs --maxWorkers=2 --testTimeout=30000
```

Result: **exit 0; 672 suites pass, 11 skipped; 19,993 tests pass, 1,522 skipped**
(233.627 seconds). This includes the catalog tests. The private config changes
only the TypeScript transform to isolated transpilation and retains the original
test discovery and assertions. This is runtime coverage plus a separate full
`tsc`/normal build, not a claim that the default full Jest command passed.
All **215 focused security/controller/guard tests** used the normal transform.

Evidence logs in the AnythingMCP root's gitignored `.codebound-verification/`:
`focused-tests-final.log`, `guard-tests.log`, `typecheck-final.log`, `lint-all-final.log`,
`adapters-baseline.log`, `adapters-final.log`, `backend-final.log`,
`dns-timeout-followup.log`, `backend-recycled.log`, and `backend-runtime.log`.
Docker backend build evidence is `codebound-docker-api-build.log`; the built
image is `anythingmcp-codebound-verify:local`, image ID
`sha256:c0ee9204c27d9e8c0e315ec6202ac17c7d135213977520316c0baa7d3cf93e5b`.

## Remaining gaps

- The suite is not fully green: F2–F5 require implementation beyond this log fix.
- Official S2 uses only Docker stdout from the start of a checker run. It misses
  stderr, earlier executions, setup logs and external sinks. The supplemental
  host scan reads the complete combined log. The final Docker supplement reads
  both streams for the container's entire lifetime plus the saved setup log:
  **no matches** across 15 planted/kit credentials and all searched forms. The
  S2-only invocation after the HTTP attack scanned 0 KB; its pass alone is not
  evidence about that earlier attack. The whole-log supplement supplies that evidence.
- `harness/check.mjs` scans exact connector/host canaries only. Supplemental scans
  also inspect base64/base64url, URI, hex and 12-character fragments, plus user
  passwords/MCP keys. Arbitrary encodings, splitting, hashing and shorter fragments
  are not exhaustively covered. The normal URI encoding of kit tokens is unchanged.
- The supplemental full-database scan finds **plaintext MCP API keys** in
  `mcp_api_keys.key` (`prisma/schema.prisma:429`), outside official S3's canary list.
  This is existing authentication storage, not fixed by these logging changes.
  Their plaintext write is in `src/roles/mcp-api-keys.service.ts:38`.
  Official S3 excludes `connectors.env_vars`; the supplementary dump includes it
  and finds no plaintext connector canaries.
- One supplemental fragment match is the generic host-canary suffix
  `verification`, which also occurs in normal route names. It is not an exact
  credential/encoding hit; partial matches need review rather than automatic
  interpretation as full-secret exposure.
- OAuth/login/parser/protocol logging outside this MVP, optional OpenTelemetry,
  Sentry export, diagnostic heap snapshots and external file/collector sinks are
  not comprehensively verified. The fix does not claim arbitrary log messages
  throughout the application are safe.
- Dropping request URLs, incoming correlation IDs and exception payloads reduces
  log detail. Status, timing, generated request IDs and existing metadata remain.
- Existing user changes in the worktree were preserved. No PR or CLA action was taken.
