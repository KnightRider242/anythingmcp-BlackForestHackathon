# Marketplace script installation (Milestone 6)

Install **Hacker News** from the existing marketplace while signed in. No API
key is needed. The connector installation also creates **Hacker News top story
summary**, owned by the installing user in their active organization. Open
**CODEBOUND Scripts** to edit or run it. The script calls
`hackernews_top_stories` exactly once and returns `{returnedCount,topIds}` with
at most ten IDs. It does not fetch titles, paginate, stream or claim complete
coverage. Public results change with Hacker News; the deterministic fixture uses
500 IDs (1001–1500) and returns count 500 and IDs 1001–1010.

Create an owned active MCP server before installation, or attach the installed
connector to one afterwards using existing MCP server management. The existing
import endpoint attaches to an already existing default server; it does not
create a server. A client using a user JWT at `/mcp/<server-id>` can discover
the `codebound_script_…` tool and invoke it. The script uses the same owner,
organization, role, server-scope/grant and live-binding checks as manually
created scripts. Only the existing user JWT/per-server MCP integration is
verified; no additional OAuth compatibility is claimed.

## Template and installation contract

Only the bundled, reviewed adapter catalog supplies templates. An optional
`codeboundScripts` array contains exactly one template for this milestone:
`key`, `name`, `description`, `source`, `inputSchema`, `outputSchema`, and
`toolName`. See `packages/backend/src/adapters/intl/hackernews.json` and
[tool-definition.md](../tool-definition.md#codebound-scripts). Runtime validation
uses the shared script-definition validators; the CLI catalog gate independently
checks the envelope, sizes and enabled REST GET tool reference. Template content
is included in the catalog version. Credentials are never interpolated into
script source or schema documents. Client-supplied templates are ignored.

`AdaptersService.importAdapter()` keeps the ordinary import path for adapters
without templates. For a script-bearing adapter it delegates to
`MarketplaceScriptsService` using the verified dashboard principal. Within one
PostgreSQL transaction, an owner/org/slug advisory lock serializes retries,
then the service creates the connector and its tools, computes the actual live
tool fingerprint, and calls `ScriptPersistenceService.createForInstallation()`.
That method applies the same principal authentication, definition validation,
secret checks, ownership and binding approval as ordinary creation, reading the
new tool/connector through the transaction client. It is a trusted internal
method, not a public endpoint. No script code executes during installation.

Invalid templates, missing tools, failed live authorization or failed script
creation roll back the connector, tools and script together. Unexpected DB
errors are sanitized. Registry refresh follows commit; a refresh failure is
logged without undoing an installed connector or duplicating it on retry.
Existing request-time MCP refresh still rechecks database authorization.

The connector's existing JSON config carries `codeboundMarketplaceSlug`; no
schema or migration is added. Retries for that same owner/org/slug return the
same connector with `scriptsInstalled:0` and reauthenticate the caller. They do
not overwrite source edits, change credentials, restore deliberately deleted
scripts, repair changed bindings or apply newer templates. A first install
returns `scriptsInstalled:1`. Separate owners/organizations get independent
installations. Existing installations from before this milestone are not
silently adopted or modified. Delete the script before deleting a referenced
connector, respecting existing foreign-key restrictions and receipt retention.

## Manual reproduction

Use root AGENTS.md setup (Node >=22.12, PostgreSQL on 5433, existing migrations
and Prisma generation), then from root:

```sh
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
npm run dev
```

At `http://localhost:3000`, sign in, create an MCP server if needed, install
Hacker News through Marketplace, then open CODEBOUND Scripts. Run its summary
with `{}` as input. The equivalent dashboard call is:

```sh
curl -X POST http://localhost:4000/api/adapters/hackernews/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl http://localhost:4000/api/codebound/scripts -H "Authorization: Bearer $TOKEN"
```

Use the returned script ID and revision with the existing execution endpoint
([EXECUTION.md](EXECUTION.md)), or connect an MCP client to the server reported
by installation ([MCP.md](MCP.md)). Never send user/org IDs as authority.

## Repeatable integration checks (PowerShell)

Use only this disposable database and public fixture secrets. From root:

```powershell
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
docker run --rm -d --name codebound-marketplace-test-db -e POSTGRES_PASSWORD=codebound-test-only -e POSTGRES_DB=codebound_test -p 127.0.0.1:55520:5432 postgres:17-alpine
Set-Location packages/backend
$env:DATABASE_URL='postgresql://postgres:codebound-test-only@127.0.0.1:55520/codebound_test'
$env:CODEBOUND_TEST_DATABASE_URL=$env:DATABASE_URL
$env:DEPLOYMENT_MODE='self-hosted'
$env:MCP_AUTH_MODE='legacy'
$env:JWT_SECRET='codebound-public-test-jwt-secret-only'
$env:ENCRYPTION_KEY='codebound-public-test-key-32-bytes'
$env:REDIS_URL=''
$env:RUN_CODEBOUND_MARKETPLACE_LIVE='1'
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path src/codebound/gateway/fixtures/localhost.cert.pem).Path
npx prisma migrate deploy
npm run build
npm test -- --runInBand --silent --runTestsByPath src/adapters/marketplace-scripts.integration.spec.ts
```

The fixture loads the actual built AppModule without provider overrides. In
controlled mode it changes only the local in-memory catalog base URLs to a
controlled HTTPS server. The bundled script is unchanged, TLS verification and
SSRF protection stay enabled, and Docker networking stays disabled. Assertions
cover actual installation, rollback after tool creation, concurrent retries,
exact bindings, script listing, HTTP/MCP execution, receipt/audit persistence,
cross-owner/organization denial, edits/deletion on retry, and ordinary OpenPLZ
installation without scripts. SDK/protocol assertions are not mocked.

For an additional run against the actual public Hacker News endpoint:

```powershell
$env:RUN_CODEBOUND_MARKETPLACE_PUBLIC='1'
npm test -- --runInBand --silent --runTestsByPath src/adapters/marketplace-scripts.integration.spec.ts
Remove-Item Env:RUN_CODEBOUND_MARKETPLACE_PUBLIC
docker stop codebound-marketplace-test-db
```

Public mode leaves the Hacker News catalog endpoint unchanged and depends on
internet/upstream availability. On Linux/macOS use equivalent exported variables
and certificate paths; Windows with Linux Docker was exercised locally.

Other checks from `packages/backend`:

```sh
npm test -- --runInBand --silent --runTestsByPath src/adapters/codebound-templates.spec.ts src/adapters/marketplace-scripts.service.spec.ts src/adapters/adapters.service.spec.ts src/adapters/adapters.controller.spec.ts src/adapters/mcp-adapter.spec.ts src/codebound/persistence/script-persistence.service.spec.ts src/codebound/gateway/gateway.spec.ts src/adapters/intl/hackernews.live.spec.ts src/adapters/catalog.spec.ts
npx tsc --noEmit -p tsconfig.json
npm run lint:check
```

From root:

```sh
node --test scripts/validate-adapters.test.mjs
node scripts/validate-adapters.mjs --warn
node scripts/regenerate-catalog.mjs
node scripts/adapter-count.mjs --check
```

## Deployment and remaining limits

Cloud and self-hosted use the same reviewed catalog, JWT authorization and
transactional installation. Installation needs PostgreSQL but does not need the
sandbox to be available; execution still fails closed if isolation is unavailable.
No new runtime, infrastructure or deployment-mode bypass is introduced.

Script-bearing installs currently require the dashboard JWT principal. The
shared chat-setup context lacks verified token timestamps, so it fails closed
with a dashboard-install instruction. No authority is synthesized for that path.
Personal owner-only script policy remains the MVP ownership model. General
marketplace ownership, multiple account installs per owner/slug, template upgrades
and automatic reinstallation of deleted scripts are deferred. Existing license
admission checks still apply to retries. Full saved JSON Schema semantics remain
pending, as in prior milestones. Changes to connector configuration can invalidate
the binding; rebind/save through the Scripts UI instead of bypassing validation.
Existing MCP discovery examines at most the first 32 owned scripts and limits
metadata to 64 KiB per request. An installed script beyond those bounds may not
appear in tools/list even when its binding is authorized; this milestone does
not change that pre-existing MCP limit. The Scripts page uses its existing
paged owner-scoped API.

## Changed files

Final focused review: no high/critical or straightforward medium production
defect was confirmed. Added a real tool-insertion constraint failure to the
marketplace fixture and a matching unit regression, confirming rollback and
sanitized errors before script persistence. The reviewed run passed 9,052
focused/catalog Jest tests, 37 real database/MCP/marketplace regressions, the
additional public Hacker News run and 27 CLI validator tests. Backend
TypeScript, lint (14 existing warnings) and build passed. No production code,
EE, Prisma schema or frontend changes were needed for this review.

Validation recorded on Windows with Linux Docker: 9,040 focused/catalog Jest
tests plus 11 installer boundary tests passed; 37 real PostgreSQL/MCP/marketplace
regression tests passed; the additional public Hacker News run passed. The CLI
validator suite passed 27 tests. All 490 adapters validated with 1,458 existing
warnings; catalog regeneration and count checks passed. Backend TypeScript,
Prisma validation/generation and build passed. ESLint passed with 14 existing
warnings and no warnings in changed TypeScript files. Initial test failures
(a Jest cross-realm clone, an incorrect test filename, and a missing fixture MCP
server) were corrected before these successful runs. No frontend files changed.

- `packages/backend/src/adapters/{adapters.controller.ts,adapters.controller.spec.ts,adapters.module.ts,adapters.service.ts}`
- `packages/backend/src/adapters/{catalog.ts,catalog-fingerprint.ts,codebound-templates.ts,codebound-templates.spec.ts}`
- `packages/backend/src/adapters/{marketplace-scripts.service.ts,marketplace-scripts.service.spec.ts,marketplace-scripts.integration.spec.ts,fixtures/marketplace-flow.cjs,intl/hackernews.json}`
- `packages/backend/src/codebound/{persistence/script-persistence.service.ts,gateway/bound-read-authorization.service.ts}`
- `scripts/{validate-adapters.mjs,validate-adapters.test.mjs}`
- `docs/{tool-definition.md,codebound/README.md,codebound/MARKETPLACE.md}`
