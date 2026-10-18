# Official CODEBOUND attack-card verification

Run: d37244e1-5f94-4d15-ac80-63e49fe65552. Backend: localhost:4001; existing database: localhost:5434/codeboundkit.

Definitions: official cards/CARDS.md, SHA-256 f176ffddaa3970f73e280d0896795d3644e885854762edfac3a01aedc5c8d7e3. No kit/checker/mock code or setup changed.

| Card/probe | Actor | Result | Evidence type | Meaning / limitation |
|---|---|---|---|---|
| A1: Foreign Payroll by name | bob | PASS | LIVE | All recorded live assertions passed. |
| A2: Foreign Payroll by internal ID | bob | PASS | LIVE | All recorded live assertions passed. |
| A3: Read unbound connector environment | bob | PASS | LIVE | All recorded live assertions passed. |
| A4: TCP connection to metadata 169.254.169.254 | bob | PASS | LIVE | All recorded live assertions passed. |
| A5: Outside and unbound Carrier network access | bob | PASS | LIVE | All recorded live assertions passed. |
| A6: Host environment and host /etc canary | bob | PASS | LIVE | All recorded live assertions passed. |
| A7: Write A temporary file, then read from B | alice then bob | PASS | LIVE + Docker inspection | A writes/readbacks `/tmp` file; B gets ENOENT. Distinct containers, bounded private tmpfs, no bind mounts/volumes; both removed. |
| A8: Infinite CPU loop | bob | PASS | LIVE | All recorded live assertions passed. |
| A9: Exhaust container memory | bob | PASS | LIVE | All recorded live assertions passed. |
| A10: One million connector calls | bob | PASS | LIVE | All recorded live assertions passed. |
| A11: Carol Staff Payroll denial and required audit | carol | PASS | LIVE | Both attempts refused, no Payroll request; two fresh Carol/A/server audits with empty input, no output and fixed denial text. |
| A12: Cloud Host-script creation/import/execution | not run | NOT_APPLICABLE | UNSUPPORTED OPTIONAL FUNCTIONALITY | Host scripts are not implemented; this is self-hosted. No Cloud 404 execution was performed. |
| A13: Print injected secret; mask output/log/audit with *** | not run | UNSUPPORTED | UNSUPPORTED OPTIONAL FUNCTIONALITY | F5/secret injection absent. No real credential injected to fake coverage. Echo-rejection tests and fixed errors are not A13 masking. |
| stderr_env: Supplementary environment/error logging probe | bob | PASS | LIVE | All recorded live assertions passed. |
| stdout_env: Supplementary environment/error logging probe | bob | PASS | LIVE | All recorded live assertions passed. |
| thrown_env: Supplementary environment/error logging probe | bob | PASS | LIVE | All recorded live assertions passed. |
| foreign_manifest: Reject foreign binding before persistence | bob | PASS | LIVE | All recorded live assertions passed. |

Failures are not converted to passes. A7 requires a successful write/readback in A before B's ENOENT counts. A1/A2 require fresh exact-execution denial audits in B. A11 requires a fresh Carol/A/Payroll/server denial audit. This verifier never writes audit rows.

Every executed script first calls mock_erp_ping with a nonce verified in the correct tenant's log. Carol primes her direct MCP call similarly. S2 runs after every executed card and supplementary probe. Private JSON records all assertions and sanitized evidence.

A6 uses positive host-file/configured host-environment canaries in host-backend mode. Configured host marker matches kit state: false. Both values are checked for leaks without printing or changing either. The worker's /etc/passwd is not host /etc. A Docker-backend /etc mount was not separately tested.

Automated tests are distinct from authenticated live card runs. The real Docker suite was rerun: 23/23 pass, including overlapping private-tmpfs containers, size exhaustion, CPU/OOM/PID/network/host-canary/cleanup. Focused controller/supervisor tests pass 57/57, including fixed denial payloads, repeated audits and refusal before session routing. Gateway policy/echo tests use database/HTTP mocks and were not rerun in this task. None certifies a Cloud Host-script run or injected-secret `***` masking.

Evidence: E:\Projs\codebound-kit\.codebound\attacks\d37244e1-5f94-4d15-ac80-63e49fe65552\report.json. Latest JSON: E:\Projs\codebound-kit\.codebound\f234-attack-cards-latest.json. Only sanitized metadata is written; credentials and raw response/error bodies are withheld. Temporary probe scripts removed: true. Cleanup uses revision-aware authenticated APIs; workflows, credentials and setup are preserved.

## A7 change and evidence

The earlier run (`a7de8da7-83cc-4b70-a984-b95599d9a721`) could not certify A7 because the A writer received EROFS. Its private evidence is preserved. This run completes the official positive-write scenario.

`packages/backend/src/codebound/sandbox/docker-sandbox-runner.ts:64` adds exactly one Docker tmpfs:

```text
/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=65534,gid=65534
```

The root filesystem remains read-only. Network none, UID/GID 65534, all capabilities dropped, no-new-privileges, PID/CPU/memory/wall-clock limits, IPC isolation and disabled Docker logging remain enforced. No bind mounts, named/anonymous volumes, shared mount sources or extra network access were introduced. Tmpfs uses the existing memory cgroup; equal memory/swap limits prohibit additional swap allowance. This same Linux Docker runner policy applies in self-hosted and Cloud modes; no Host execution or fallback was added.

Alice successfully wrote and read back her nonce-named file. A's execution/container ended before Bob read exactly that path and received ENOENT. The verifier independently inspected both actual containers, their private tmpfs configuration, lack of volumes/binds, read-only root and resource limits. Container IDs were distinct and neither remained afterward. Every script made its own verified, correct-tenant priming ping.

The additional real Docker regression keeps A alive with its file while B attempts the read, verifies A still reads its own file afterward, observes ENOSPC beyond 8 MiB, and verifies the path is absent in another newly created container after teardown. Per-test container inventories confirm cleanup, including resource-failure tests. Container removal destroys the private filesystem namespace/data lifetime; this is not a claim of forensic RAM zeroization on the Docker host.

## A11 cause, fix and evidence

Role-hidden tools never receive an SDK invocation callback (`mcp-endpoint.controller.ts`, `planToolSet`), so normal executor logging could not record Carol's refusal. The new `refuseRoleRestrictedCall` boundary checks the live role allowlist after authenticated server membership and connector resolution, before stateless dispatch or stateful session reuse. It resolves only tools attached to this server in its organization. Existing tool visibility and execution permissions remain unchanged.

The boundary awaits `AuditService.logInvocation` with only the resolved tool ID, authenticated user ID, server organization/server ID, empty input, ERROR status, fixed `FORBIDDEN: Tool access denied` text and fixed client marker. It copies no tool definitions, arguments, output, headers, request IDs, email or key names. Each denial is a fixed-size record; deduplication is disabled so consecutive callers/attempts retain independently attributable rows. No background audit queue was introduced. The existing authenticated principal request guard still applies.

The live verifier used Carol's existing MCP key, proved Payroll remained absent from her listed surface, made two refused calls with disposable untrusted arguments, and found two fresh, separate audits belonging to Carol, workspace A and its addressed server. Both records had empty input/no output/fixed error; the mock log contained zero Payroll requests. A1/A2 continue to pass their caller/workspace/receipt audit assertions.

Persistence uses the existing AuditService. A database outage can still prevent a durable row; it cannot authorize execution. The service's normal persistence handling is best effort, and controller-level exceptions produce only a fixed diagnostic. No claim of guaranteed storage during database failure is made. This fix covers ordinary single-tool calls at `/mcp/:serverId`, including session reuse; arbitrary batch/global-endpoint denial auditing was not certified by A11 and remains outside this verification.

## Actual verification

| Check | Actual result |
|---|---|
| Live official A1–A11 | PASS; every executed card and four supplementary probes also pass S2 |
| Verifier helper tests | 15/15 PASS |
| Focused controller/supervisor Jest | 57/57 PASS, 3 suites |
| Real Docker supervisor Jest | 23/23 PASS, 1 suite; live gate enabled |
| Backend TypeScript | PASS |
| ESLint on all five touched backend TS files | PASS, without autofix |
| Isolated backend build/start build | PASS |
| Backend adapter catalogue tests | 8,882/8,882 PASS, 2 suites |
| Adapter validation | 490/490 PASS; 1,458 existing warnings |
| Syntax and whitespace checks | PASS |

Commands from repository root unless noted:

```powershell
node --test scripts/verify-codebound-f234-attacks.test.mjs
node --check scripts/verify-codebound-f234-attacks.mjs
node scripts/verify-codebound-f234-attacks.mjs E:/Projs/codebound-kit/.codebound/state.json
npm run codebound:build
npm run codebound:start -- --log E:/Projs/codebound-kit/.codebound/f234-backend.log
node scripts/validate-adapters.mjs --warn
```

From `packages/backend`:

```powershell
npm test -- --runInBand --testPathPatterns='mcp-denial-audit|docker-sandbox-runner.spec|mcp-endpoint.controller.spec' --silent
$env:RUN_CODEBOUND_SANDBOX_LIVE='1'
npm test -- --runInBand --testPathPatterns='docker-sandbox-runner.live.spec' --silent
npx tsc --noEmit -p tsconfig.json
npx eslint src/mcp-server/mcp-endpoint.controller.ts src/mcp-server/mcp-denial-audit.spec.ts src/codebound/sandbox/docker-sandbox-runner.ts src/codebound/sandbox/docker-sandbox-runner.spec.ts src/codebound/sandbox/docker-sandbox-runner.live.spec.ts
npm test -- --runInBand --testPathPatterns='adapters/catalog' --silent
```

After the live attacks, the unchanged official `npm run check` from `E:\Projs\codebound-kit` reported:

| Official check | Actual result |
|---|---|
| P1, P2, F1 | PASS |
| F2 | PASS: 4 / 2 correct rows |
| F3 | PASS: 800 complete / 137 complete / 200 incomplete |
| F4 | PASS: 5 / 2 correct rows |
| S1 | PASS: 9 outputs |
| S2 | PASS: 420 KB backend logs |
| S3 | PASS: 709 KB database data |
| Mandatory | **6/6** |
| Secret scans | **3/3** |
| Optional F5 | Missing; checker exits 1 |

Acceptance evidence: `E:\Projs\codebound-kit\.codebound\knockout-official-check.log` and `knockout-official-check.json`. A12 remains not applicable (Host unsupported, Cloud not tested); A13 remains unsupported (optional F5 absent). A6's pre-existing configured-host-marker/state-marker mismatch remains documented above; both are scanned without printing or changing them. Docker-host/daemon compromise and plaintext MCP-key storage remain outside the isolation/scan guarantees; no credential storage change was made here.

## Files and operational scope

New backend changes: `packages/backend/src/codebound/sandbox/docker-sandbox-runner.ts`, its `.spec.ts` and `.live.spec.ts`, `packages/backend/src/mcp-server/mcp-endpoint.controller.ts`, and new `mcp-denial-audit.spec.ts`. Updated verifier and this report preserve the previous uncommitted verifier/helper-test work. No schema migration or security-document deletion was needed.

Only backend port 4001 was restarted, using the existing `.env.codebound.local`, database on 5434 and UTF-8 log file. Port 4000 and database port 5433 were untouched. No setup/reset, credential rotation, kit/checker/reference/mock edit, commit or push occurred. Temporary probe scripts were deleted through authenticated revision-aware endpoints, and all attack containers were removed. The private report's `scope.backendChanged:false` describes the verifier itself (which makes no source edits), not this implementation task's backend fixes.
