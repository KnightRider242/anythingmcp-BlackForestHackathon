# CODEBOUND F2/F3/F4 implementation

Date: 18 October 2026. Branch: `feat/codebound-lifecycle`. Changes are local and uncommitted.

## Scope and acceptance

Implemented the three mandatory workflows against the existing backend at `http://localhost:4001` and existing `codebound-kit-db` database at `localhost:5434/codeboundkit`. F5 remains out of scope.

No setup was rerun, database reset, volume deletion, credential rotation, checker/reference/mock modification, commit, or push was performed. The original port 4000 instance and port 5433 database were not changed. Existing security changes and verification documentation remain in the working tree.

The baseline below is the latest complete official result supplied with the task; it is not presented as a new before-change execution performed during this implementation.

| Card | Supplied baseline | Final official run |
|---|---|---|
| P1 | PASS | PASS: 30 offers |
| P2 | PASS | PASS: invalid price path rejected |
| F1 | PASS | PASS: three typed script tools |
| F2 | CONNECTOR_ERROR | PASS: thresholds 5/10 produce 4/2 correct rows |
| F3 | CONNECTOR_ERROR | PASS: fasteners 800/true; adhesives 137/true; legacy 200/false |
| F4 | CONNECTOR_ERROR | PASS: days 3/7 produce 5/2 correct rows |
| F5, optional | Unimplemented | Unimplemented |
| S1 | PASS: 9 outputs | PASS: 9 outputs |
| S2 | PASS: 127 KB reported | PASS: 259 KB of decoded UTF-8 backend logs |
| S3 | PASS: 71 KB reported | PASS: 348 KB of database data |
| Mandatory | 3/6 | **6/6** |
| Secret scans | 3/3 | **3/3** |

The checker still returns failure for the absent optional F5. This is not an all-cards-green result. Evidence is retained under `E:\Projs\codebound-kit\.codebound\`: `f234-F2.log`, `f234-F3.log`, `f234-F4.log`, `f234-full-final.log`, and `f234-official-final.json`. The final full run followed the live attacks.

## Root causes of CONNECTOR_ERROR

The saved F1 scripts were deliberately first-page placeholders. They did not contain the pagination, supplier batch POST, or carrier join implementations. Several independent enforcement boundaries also prevented those workflows:

- `packages/backend/src/codebound/contracts.ts` and `contracts.validation.ts` permitted one connector call and only the fixed `connector.read` IPC operation.
- `gateway/bound-read-authorization.service.ts` supported a single approved binding and GET tools. Supplier prices are an explicitly defined POST tool.
- `gateway/bound-rest-executor.service.ts` required HTTPS; the existing approved kit connectors resolve to HTTP on localhost ports 4101–4104.
- `sandbox/docker-sandbox-runner.ts` terminated on every failed connector reply. `execution/script-execution.service.ts` also retained every connector error as a terminal failure. A script could not admit the Supplier legacy catalogue's page-5 HTTP 503 and return its valid partial count.
- Persistence completion validators and the database receipt constraint also limited recorded connector calls to one. Updating only the worker would leave execution or receipt finalization broken.

Current implementation references: `contracts.ts:44`, `gateway/bound-read-authorization.service.ts:47`, `gateway/bound-rest-executor.service.ts:19`, `gateway/authorized-connector-gateway.service.ts:125`, and `persistence/script-persistence.service.ts:108`.

## Architecture and security controls

### Explicit bindings and live authorization

The original primary `binding` and `api.read(arguments)` remain supported. A script may add up to seven `additionalBindings`; `api.call(approvedToolName, arguments)` selects among that explicit manifest. Internal tool IDs, connector IDs, URLs, methods, headers and credentials are not script-selectable capabilities.

Every binding is approved through authenticated owner/workspace-scoped management. Before execution and every connector call, live authorization checks ownership, active membership/session revocation, roles, license, MCP server attachment/grants, enabled tool, active connector, and definition fingerprint. All bound capabilities are checked again on each call. The gateway retains a name-to-binding routing map, not cached permission decisions.

For MCP API-key calls, the backend now carries the verified credential's internal ID in the trusted principal and rechecks that active key against its owner, workspace and server between calls. Raw keys do not enter IPC or receipts. Changes to connector credentials/configuration are fingerprint changes and fail closed until the script is approved again.

Additional bindings are a bounded JSON manifest on the existing script row. The original primary binding's composite foreign keys remain intact. Additional entries are checked against live database rows, rather than acquiring authority from their claimed IDs. Deleting or changing an additional tool causes execution to fail closed. Additional entries do not have separate relational foreign keys; this is an intentional persistence compatibility tradeoff.

### Trusted GET/POST transport

GET remains supported. POST requires an approved endpoint definition with a strict `bodyMapping` from declared, validated arguments. The worker cannot provide a mapping or change a method. Request bodies are bounded JSON, not templates that scripts can turn into arbitrary headers or destinations.

The narrowly scoped test exception is `CODEBOUND_TEST_HTTP_ORIGINS`, enabled only for `NODE_ENV=development|test`, with the shared `DeploymentService.isSelfHosted()` policy, and only for exact `http://localhost:4101` through `:4104` origins explicitly listed by the operator. The local ignored `.env.codebound.local` now sets those four origins. Port 4199, alternate hosts/IP literals, production and Cloud do not qualify. HTTPS remains required otherwise.

The transport retains guarded DNS lookup, no proxy inheritance, redirect prohibition, normal TLS verification, fixed approved paths/headers/authentication, bounded request/response bodies and plain JSON validation. The HTTP test path ignores broad host allowlists and permits loopback only through the guarded connection policy; HTTPS retains existing explicit operator host grants. Raw upstream exceptions/configuration are not logged or returned.

Credential echo checks cover known connector variables, authentication/header components and secret query values, including raw, URI-encoded, base64 and hex representations. Echoes are fatal even inside a 503 response. Only a validated, sanitized HTTP 5xx response becomes a catchable `CONNECTOR_ERROR`; policy, authentication, cancellation, limits, malformed responses and transport/security failures remain fatal.

### Bounded execution and Docker isolation

| Resource | Ceiling |
|---|---|
| Connector calls | 128 per execution |
| In-flight connector calls | 1; overlapping requests are rejected, no queue |
| Total decoded connector response bytes | 8 MiB, including received 5xx bodies |
| One connector response | 512 KiB |
| Connector request body / argument object | 16 KiB |
| Script source | 32 KiB |
| Final output | 16 KiB |
| IPC frame | 600 KiB |
| Script stderr | 4 KiB, discarded by supervisor |
| Supervisor wall time | 30 seconds, also bounded by caller expiry |
| Independent PID-1 watchdog | 35 seconds |
| Container memory / CPU / processes | 128 MiB / 0.5 core / 16 |
| Backend admission | 2 executions per process; 1 per owner; no queue |

The supervisor independently checks request IDs, sequentiality, call count, aggregate reply size and terminal errors. The gateway independently enforces budgets and live authorization. Receipts record aggregate transport bytes, including recoverable failures. Fatal sessions are aborted and cannot be resumed.

Scripts still execute exclusively in disposable Docker containers with no network, read-only filesystem, UID/GID 65534, dropped capabilities, no-new-privileges, process/memory limits, no host mounts and Docker logging disabled. No host eval/vm/Function fallback was introduced. The existing `new Function` remains solely inside the isolated worker.

Per-call audits contain trusted binding IDs, execution ID, status, duration and fixed error codes, never source/arguments/headers/raw responses. Additional approved tools are attributed correctly. Unknown tool selections are refused and audited against the script's primary binding. Denied gateway opening is now audited as well. Run receipts retain cancellation and resource failures, including worker-side budget exhaustion.

## Persistence and installation

Additive migration: `packages/backend/prisma/migrations/20261018090000_codebound_multi_tool/migration.sql`. Existing issue [#1](https://github.com/KnightRider242/anythingmcp-BlackForestHackathon/issues/1) already tracks CODEBOUND script/binding/receipt persistence and schema work.

The migration adds `additional_bindings` with default `[]`, an array/size constraint, and replaces only the receipt bounds constraint with 128 calls / 8 MiB. It preserves all old rows, primary binding foreign keys, receipt identity triggers, state checks and owner/tenant checks. It was deployed using `node scripts/migrate-codebound-local.mjs`, which refuses any destination other than the existing localhost:5434/codeboundkit configuration on backend port 4001.

`scripts/codebound-kit-workflows.mjs` contains all three complete script sources. `scripts/install-codebound-kit-f234.mjs` authenticates Alice using the existing kit state, validates localhost:4001/Alpha, resolves approved bindings, preserves the typed input schemas, and updates only the three existing scripts through revision-aware authenticated management endpoints. All three advanced from revision 1 to revision 2. A second run printed `Unchanged` for every script and did not advance revisions. Names, IDs and existing MCP-key discovery were preserved.

- F2 walks active ERP pages, batches at most 100 SKUs per Supplier POST, excludes missing prices, rounds to one decimal before strict threshold filtering, and sorts descending drift. No fixture rows or SKU identifiers are embedded.
- F3 walks until an empty page, with a 100-page script ceiling. A sanitized service failure returns the count so far with `complete:false`; reaching the page ceiling also cannot claim completion.
- F4 walks shipped ERP orders, calls the approved Carrier tool for each tracking number, uses the supplied `as_of`, excludes delivered parcels, applies a strict scan cutoff, and sorts oldest first.

Read-only inspection of the final persisted receipts confirmed 8 connector calls / 55,196 response bytes per F2 execution; F3 used 17 / 4 / 5 calls and 55,681 / 9,601 / 14,017 bytes; each F4 execution used 62 calls / 18,819 bytes. The official checker independently verified the required mock request paths during each execution.

## Log coverage correction

The pre-existing `backend-codebound.log` had a UTF-16LE prefix followed by UTF-8 output. The kit reads logs as UTF-8; a passing scan of mixed encodings does not establish coverage of the UTF-16 portion.

The original file was preserved. Its 131,916-byte UTF-16 prefix was decoded and combined with its 92,834-byte UTF-8 suffix into `.codebound/f234-backend.log`. The previous team configuration was preserved as `.codebound/f234-team-before.json`; only `logs.file` now points to that UTF-8 evidence file. New backend stdout AND stderr append as raw UTF-8 through `npm run codebound:start -- --log <file>`. The launcher waits for child stream closure before closing the log. A regression test checks both streams, preservation of prior contents and absence of NUL encoding artifacts. Final S2 passed against this complete readable history plus the new runtime logs.

After stopping the verification backend, a supplementary scan of all 268,195 log bytes found **zero matches** for the seven actual connector canaries in raw, URI-encoded, base64, lowercase hex, uppercase hex, or 12-character-prefix form. No credential values were printed. Evidence: `.codebound/f234-manual-log-scan.json`.

## Verification and attack findings

All commands were run from the repository root unless a working directory is stated.

| Verification | Actual result |
|---|---|
| `npm run codebound:build` | PASS: Prisma generation and Nest build |
| `node scripts/migrate-codebound-local.mjs` | PASS: additive migration applied to existing DB only |
| F234 installer, then identical rerun | PASS: three revision-2 upgrades, then three unchanged definitions |
| Kit `npm run check -- --card F2`, then F3, then F4 | PASS, in that order |
| Kit `npm run check` after live attacks | Mandatory 6/6; scans 3/3; optional F5 absent |
| Backend `npx tsc --noEmit -p tsconfig.json` | PASS |
| Backend `npm run lint:check` | PASS: 0 errors, 14 existing warnings; no autofix |
| `node --test scripts/codebound-local.test.mjs` | PASS: 5/5 |
| `node scripts/validate-adapters.mjs --warn` | PASS: 490/490; 1,458 existing warnings |
| Backend focused CODEBOUND + catalogue Jest with real Docker enabled | PASS: 14 suites, 9,133 tests; 54 tests skipped in five opt-in disposable-database suites |
| Real Docker sandbox tests | PASS: all 22, including cancellation and timeout mid-pagination; container absence checked after every case |
| Final gateway/orchestration recheck after shared deployment-policy alignment | PASS: 3 suites, 107 tests; followed by passing backend typecheck, build and full official acceptance run |
| Broad backend runtime rerun | 669 suites / 20,005 tests PASS; 3 unchanged-code tests FAIL; 11 suites / 1,526 tests skipped; details below |
| `git diff --check` | PASS |

The finalized focused run used `RUN_CODEBOUND_SANDBOX_LIVE=1 npm test -- --runInBand --testPathPatterns='codebound|adapters/catalog' --silent` from `packages/backend`. Evidence: `.codebound/f234-stage-A-final.log`. Its expected logger messages come from tests deliberately simulating receipt/audit/cleanup failures; the assertions pass.

The initial broad default-transform `npm test -- --runInBand --silent` completed with 668 suites passing, 4 failing, 11 skipped; 20,004 tests passed, 4 failed, 1,526 skipped. Three failures were in unchanged image-size/SSRF tests. A fourth, the newly added denied-opening audit test, loaded the execution service before its audit edit during that long run. The fresh focused run and subsequent broad runtime rerun pass that test. The initial broad run is not claimed to pass or to represent an atomic checkout snapshot.

The broad rerun used the package's Jest settings with a private config at `.codebound/f234-jest-runtime.json`, changing only ts-jest to isolated transpilation; backend typechecking was run separately. No test assertions, test timeouts or test-selection rules were relaxed. Command from the repository root:

```powershell
npm test --workspace=packages/backend -- --runInBand --silent --config E:/Projs/codebound-kit/.codebound/f234-jest-runtime.json
```

It completed in 420.672 seconds with 669 passing suites, 3 failing suites, and 11 skipped suites; 20,005 passing tests, 3 failing tests, and 1,526 skipped tests. Evidence: `.codebound/f234-backend-final-runtime.log`. The remaining failures are:

| Unchanged test | Failure |
|---|---|
| `src/connectors/response-images.util.spec.ts:118` | 12 MiB image-result cap case hits `RangeError: Maximum call stack size exceeded` in the existing base64 regex at `response-images.util.ts:184` |
| `src/common/ssrf.util.spec.ts:37` | DNS lookup for `no-such-host.invalid` exceeds the default 5-second test timeout |
| `src/connectors/engines/database.engine.ssrf.spec.ts:61` | Allowed `db.internal` connection attempt exceeds the default 5-second test timeout |

All six associated source/spec files have no diff from HEAD, and these failures reproduce in both broad runs. A clean pre-change full-suite baseline was not recorded, so these are reported as remaining failures in unchanged code, rather than a certified before/after full-suite comparison. They were not fixed by expanding this task into unrelated image/DNS behavior. The complete backend Jest suite is therefore **not claimed green**. The final focused 107-test run independently verifies the last shared deployment-policy adjustment.

Live probes are reproducible with `node scripts/verify-codebound-f234-attacks.mjs E:\Projs\codebound-kit\.codebound\state.json`. Temporary scripts were created and deleted through authenticated APIs; retained audit/receipt history is expected. Every script probe first called Bob's bound ERP ping with a unique nonce, which the verifier checked in the mock request log. S2 was rerun after every probe.

| Probe/card | Outcome |
|---|---|
| A1: Bob selects Alpha-only Payroll by name | FORBIDDEN; denied call audited; S2 PASS |
| A2: Bob selects an Alpha internal tool ID | FORBIDDEN; denied call audited; S2 PASS |
| Foreign approved binding submitted in Bob's manifest | HTTP 403 before saving; S2 PASS |
| A3: read the host canary path inside Docker | Not readable; S2 PASS |
| A4: write worker `process.env` to stderr | No host canary present; stderr discarded; S2 PASS |
| A5: fetch `codebound-outside:4199` | Unreachable; Outside log sequence unchanged; S2 PASS |
| Print worker `process.env` to stdout | SCRIPT_ERROR from invalid IPC; S2 PASS |
| Throw an error containing worker `process.env` | Fixed SCRIPT_ERROR; S2 PASS |
| A10: attempt 1,000,000 bound connector calls | RESOURCE_LIMIT at the finite ceiling; S2 PASS |
| A11: Carol Staff calls Payroll through existing authenticated MCP | Refused; S2 PASS. The ordinary MCP refusal's audit completeness was not established by this probe. |

The new/focused automated cases additionally cover workspace mismatch, unbound selection and internal IDs, approved POST body mapping, disallowed methods/body mappings, Carol's Staff role, disabled connectors, API-key revocation between calls, changed definition fingerprints, local-HTTP scope, metadata/private destinations and DNS rebinding, call/aggregate-byte ceilings, 503 recovery versus credential echoes, cancellation/timeout, and failure teardown. Real Docker tests cover no network/DNS/host files, cgroup OOM, PID limits, infinite loops, inherited proxy secrets, dropped privileges, independent watchdog expiry and cleanup. These are not a claim that every A1–A13 card was rerun as a live kit script.

## Files changed for this implementation

Paths below are relative to `E:\Projs\anythingmcp-BlackForestHackathon`:

- `deploy/codebound/runner.cjs`, `deploy/codebound/watchdog.c`
- `packages/backend/prisma/schema.prisma`
- `packages/backend/prisma/migrations/20261018090000_codebound_multi_tool/migration.sql`
- `packages/backend/src/codebound/contracts.ts`, `contracts.validation.ts`, `contracts.spec.ts`
- `packages/backend/src/codebound/gateway/authorized-connector-gateway.service.ts`
- `packages/backend/src/codebound/gateway/bound-read-authorization.service.ts`
- `packages/backend/src/codebound/gateway/bound-rest-executor.service.ts`, `gateway.spec.ts`
- `packages/backend/src/codebound/execution/script-execution.service.ts`, `script-execution.service.spec.ts`
- `packages/backend/src/codebound/persistence/script-persistence.service.ts`, `script-persistence.service.spec.ts`
- `packages/backend/src/codebound/mcp/codebound-mcp-tools.service.ts`, `codebound-mcp-tools.service.spec.ts`
- `packages/backend/src/codebound/sandbox/docker-sandbox-runner.ts`, `docker-sandbox-runner.live.spec.ts`
- `scripts/codebound-kit-workflows.mjs`, `scripts/install-codebound-kit-f234.mjs`
- `scripts/migrate-codebound-local.mjs`, `scripts/verify-codebound-f234-attacks.mjs`
- `scripts/codebound-local.mjs`, `scripts/codebound-local.test.mjs` (extended existing uncommitted launcher work)
- `docs/codebound/F234_IMPLEMENTATION_REPORT.md`

Ignored local configuration: `.env.codebound.local` gained only the explicit test HTTP origins. In the kit, `codebound.team.json` gained the UTF-8 log path; evidence was added under `.codebound/`. Existing uncommitted audit, logger, crypto, auth, Prisma, REST engine and MCP endpoint security improvements remain present. No `ee/` files were edited.

## Remaining risks and gaps

- F5 and secret injection/direct script networking are absent, by scope. The worker receives no connector credentials. A13's injected-secret workflow is therefore not a new end-to-end capability verified here.
- The ordinary application Docker image does not supply a safe dedicated sandbox supervisor interface merely by starting Compose. This verified setup runs the backend on the host with Docker CLI access. In an application container without the trusted supervisor/Docker CLI wiring, execution fails closed with SANDBOX_UNAVAILABLE; no inline fallback was added. Rebuild the sandbox image as well as the backend after worker/watchdog changes. Do not grant an ordinary web container the host Docker socket as a shortcut.
- Docker daemon authority is powerful, and container isolation still shares the host kernel. The trusted backend/supervisor must be secured independently. Admission is per backend process, not a distributed cluster quota.
- MCP API keys remain stored in plaintext by the existing application model. Per-call key revocation was added, not a key-storage migration. S3's connector/host canaries do not establish protection of every MCP key, password or arbitrary secret.
- The kit's S1/S2/S3 scanner searches exact canary substrings. It does not by itself prove absence of encoded, partial, encrypted, fragmented or arbitrary non-canary secrets. Executor echo detection also handles raw/URI/base64/hex known credential values; regression cases explicitly exercise raw/URI/base64 echoes and credential-bearing service errors. This does not cover all transformations or side channels.
- S2 covers the configured backend stdout/stderr history. External Docker daemon, OS, reverse-proxy, database server and unrelated application logs are not included in that scan. The sandbox discards stderr and has Docker logging disabled; script stdout is validated IPC.
- Additional manifest integrity is enforced in the service/gateway, not with a separate foreign-key row for each additional binding. Direct database write access remains a privileged boundary.
- Audit writes retain the existing bounded best-effort availability policy. Receipts are finalized independently; an unavailable audit database operation is not made an unbounded execution wait. The ordinary MCP unknown/hidden-tool refusal path is outside the new script gateway audit path; A11's refusal was verified, not its full live audit trail.
- Only validated HTTP 5xx responses are script-catchable. Authentication/policy errors, malformed responses and other transport failures terminate execution rather than producing a possibly misleading partial result.

## Restart and verify

The verification backend on port 4001 was stopped after the final checks, and no sandbox containers remain. The existing database and mocks were left running. Use the existing isolated configuration; do not rerun setup or reset the database. Stop only an identified port-4001 CODEBOUND process before restarting it.

```powershell
cd E:\Projs\anythingmcp-BlackForestHackathon
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
node scripts/migrate-codebound-local.mjs  # idempotent, already applied
npm run codebound:build
npm run codebound:start -- --log E:/Projs/codebound-kit/.codebound/f234-backend.log
```

In another terminal:

```powershell
cd E:\Projs\anythingmcp-BlackForestHackathon
node scripts/install-codebound-kit-f234.mjs E:/Projs/codebound-kit/.codebound/state.json
node --test scripts/codebound-local.test.mjs

cd E:\Projs\codebound-kit
npm run check -- --card F2
npm run check -- --card F3
npm run check -- --card F4
npm run check
```

For focused real-container tests, from `packages/backend`:

```powershell
$env:RUN_CODEBOUND_SANDBOX_LIVE='1'
npm test -- --runInBand --testPathPatterns='codebound|adapters/catalog' --silent
```

The opt-in database-reset/disposable-database integration fixtures were not pointed at the existing kit database. The official live acceptance checks and authenticated upgrade/attack flows exercised its actual persistent API/MCP/Docker path.
