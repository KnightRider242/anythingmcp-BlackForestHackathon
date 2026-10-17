# CODEBOUND script persistence — Milestone 4, Phase A

[Architecture](README.md) · [Gateway](GATEWAY.md) · [Tracking issue #1](https://github.com/KnightRider242/anythingmcp-BlackForestHackathon/issues/1)

`CodeboundPersistenceModule` exports `ScriptPersistenceService`. It is deliberately
not imported by AppModule: this phase registers no HTTP/MCP routes, executes no
scripts and adds no UI. Shared contracts are unchanged. Cloud and self-hosted use
the same tables, tenant checks and storage limits; binding approval reuses the
existing gateway authorization and deployment-dependent license checks.

## Models and retention

`CodeboundScript` belongs to an organization and owner. It stores the bounded
definition, server-calculated SHA-256, revision (initially 1), schemas, exact
connector/tool IDs, binding fingerprint and timestamps. Composite foreign keys
ensure the connector belongs to that tenant/owner and the tool belongs to that
exact connector. Additional unique indexes on existing connector/tool IDs support
these foreign keys; they introduce no new uniqueness restriction on existing data.

`CodeboundScriptRun` has a globally unique execution ID, tenant, owner/caller,
original script ID, optional live script link, immutable executed revision/hash,
status, timestamps, bounded metrics and fixed error information. Caller equals
owner for this MVP; this is not a marketplace ownership policy. Nullable tenant
and owner mirror columns provide a composite live-script FK without clearing the
retained receipt's actual tenant/owner when the script is deleted.

Deleting a script, tool or connector removes the script definition and clears
the receipt's live-script link. Original ID, revision/hash and metadata remain.
Receipts have **no automatic TTL**; deleting their organization, owner or caller
cascades to remove them. A terminal receipt may still have its live link cleared
but cannot have status, metrics, identity, revision/hash or errors rewritten.
Run source, inputs, outputs, raw connector responses, credentials and logs have
no storage fields. Finalization remains possible after script deletion.

## Service contracts

- `create(principal, definition)` validates the shared definition, derives its
  hash, checks live binding authorization and stores revision 1.
- `get(principal, scriptId)` returns a detached, recursively frozen snapshot.
- `list(principal, {afterId?, limit?})` uses owner/tenant-scoped keyset pagination;
  default page size 20, maximum 100. Continue using the last returned ID.
- `update(principal, id, expectedRevision, replacement)` atomically matches the
  revision and increments it; the returned snapshot is read in the same transaction.
- `remove(principal, id, expectedRevision)` atomically deletes the matching revision.
  Missing/foreign rows return NOT_FOUND; a visible stale revision returns VERSION_CONFLICT.
- `beginRun(principal, scriptId, expectedRevision, executionId)` locks that scoped
  script row against updates/deletes, inserts a RUNNING receipt and returns its
  exact frozen snapshot. It does not open a gateway or start a sandbox. Execution
  IDs must come from trusted future orchestration, not sandbox IPC.
- `finishRun(principal, executionId, completion)` accepts only terminal status,
  bounded metrics and a shared error shape. It atomically transitions RUNNING
  once. Messages are replaced with a fixed catalog; raw messages are not stored.
- `getRun(principal, executionId)` returns only a scoped owner/caller receipt.

Principals must come from verified JWT guards. Every operation rechecks active
membership, token expiry and revocation; all script/run queries filter tenant and
owner. Create/update also call `BoundReadAuthorization.authorize` for live role,
grant, server, owner, enabled state, REST GET and exact fingerprint checks.
Reading/deleting a saved script remains possible when its connector binding is
invalid; saving an edited definition requires valid authorization again.

Recognizable secret literals and known connector environment values pasted into
definitions are rejected. No scanner can prove that arbitrary user-authored text
contains no secret; the service never copies decrypted connector configuration
to storage. Its conservative comparison can reject benign environment-value matches.
JavaScript syntax and full JSON Schema semantics are not compiled/validated in this
phase; shared structural, JSON-safety and byte validators remain authoritative.

## Migration and database protections

`20261017140000_codebound_persistence/migration.sql` is additive. It creates two
tables, the status enum, foreign keys/indexes, CHECK constraints and an immutable
receipt trigger. No existing data is rewritten, although building the supporting
indexes can block writes to large connector/tool tables during deployment.
The migration now explicitly wraps DDL in BEGIN/COMMIT. A PostgreSQL/Prisma
failure-injection test confirmed that the unwrapped version could leave earlier
DDL behind. The transaction prevents partial schema changes; a failed Prisma
migration-history entry still needs deliberate recovery before another deploy.
Prisma can report the aborted-transaction error while recording that failure.
There is no automatic down migration: dropping these tables would destroy saved
scripts/receipts. Application rollback can leave the additive tables in place.
Bound connector ownership/organization and tool-to-connector changes are restricted
by the new foreign keys while scripts reference them; retaining the tables also
retains these protections. Index creation and its locks are held until commit.

Database checks enforce source bytes/hash, positive revisions, schema object
shape, receipt tenant/owner links, initial snapshot consistency, status/error
coherence and bounded metrics. Shared validators enforce compact schema JSON at
16 KiB; the database additionally caps PostgreSQL's whitespace-expanded JSON text
at 32 KiB. Receipt wall time has a 24-hour telemetry ceiling; this does not enlarge
the sandbox's 10-second execution limit. Other ceilings remain one call, 512 KiB
connector response and 16 KiB final output. Source is capped at 32 KiB.

CHECKs and triggers are intentionally expressed in migration SQL because Prisma's
model syntax cannot represent them. Do not replace this migration with db push.
The trigger checks initial revision/hash and prevents identity changes, relinking
and terminal receipt rewrites, while permitting FK-driven link clearing.
Link clearing is refused while the original script still exists; the nullable
relation cannot be manually severed to alter live history associations.

## Verification

Use a **disposable** PostgreSQL 17 database, never production. From repository root:

```powershell
docker run --rm -d --name codebound-persistence-review -e POSTGRES_PASSWORD=codebound-test-only -e POSTGRES_DB=codebound_test -p 127.0.0.1:55520:5432 postgres:17-alpine
```

From `packages/backend`:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:codebound-test-only@127.0.0.1:55520/codebound_test'
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npx prisma migrate deploy # Must report no pending migrations
$env:CODEBOUND_TEST_DATABASE_URL = $env:DATABASE_URL
npm test -- --runInBand codebound/persistence codebound/contracts.spec.ts codebound/gateway/gateway.spec.ts adapters/catalog.spec.ts
npx tsc --noEmit --incremental false -p tsconfig.json
npx eslint src/codebound/persistence/*.ts src/codebound/gateway/codebound-gateway.module.ts
```

Finally, from the repository root: `docker stop codebound-persistence-review`.
On Linux/macOS use shell environment exports instead of PowerShell assignments;
the service and tests invoke no host-specific executables. The PostgreSQL suite
is gated by CODEBOUND_TEST_DATABASE_URL and uses real Prisma, SQL, membership,
role and binding checks; license activity is stubbed. Unit tests use database
mocks. Default skipped integration tests are not evidence of database success.
`script-migration.integration.spec.ts` uses isolated PostgreSQL schemas to test
all prior migrations, populated-table upgrade, explicit SQL rollback and an
actual failing Prisma CLI deployment. It creates and removes temporary files
within the backend workspace; Node subprocess invocation needs no shell.

## Final Phase A review

Two medium database-boundary issues were reproduced and fixed in the still
uncommitted migration: manual live-script unlinking, and partial DDL after a
Prisma migration failure. Neither was a cross-tenant service API bypass.
The expanded PostgreSQL suite checks all history operations across owner/tenant
boundaries, real non-admin role revocation, real MCP grant revocation/attachment,
all terminal statuses, receipt tampering, concurrent finalization/deletion and
rollback after an injected post-write Prisma transaction failure.
Review validation passed 152 targeted tests across five suites, including 34
Prisma persistence integration cases and four SQL/migration cases on PostgreSQL 17.
Prisma validation/generation and backend TypeScript/targeted ESLint passed. Tests
ran on Windows against a Linux PostgreSQL container, not native Linux/macOS hosts.

## Remaining scope and risks

No run orchestration, stale-RUNNING recovery, execution cancellation on script
deletion, retention job or public API is implemented. Future orchestration must
open the gateway and revalidate live authorization before execution and every
connector call, even after beginRun succeeds. Revoked callers cannot finalize
through this owner-only service; trusted crash/revocation recovery needs a later
design. The gateway's documented non-atomic revocation window remains. Windows
host/PostgreSQL Linux-container tests do not establish native Linux/macOS host
coverage. Marketplace installation remains a later delivery milestone.
