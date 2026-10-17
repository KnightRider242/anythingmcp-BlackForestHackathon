# CODEBOUND MCP tools — Milestone 5A

**Verified support is user JWT authentication on the existing per-server MCP
endpoint only. Full OAuth compatibility is not claimed.** The live tests use
locally signed user JWTs, including access-token-shaped `type`/`azp` claims and
stored grants. They do not exercise browser sign-in, PKCE, authorization/token
exchange, refresh interoperability or resource/audience negotiation.

Saved personal scripts are exposed at `http://localhost:4000/mcp/<serverId>`.
Connect an MCP client using a valid user JWT accepted by the instance's existing
MCP authentication configuration. The script's exact connector must be assigned to that
server. Its owner must remain an active organization member with permission for
the bound REST GET tool. OAuth connection grants may narrow that scope further.

Static bearer tokens, anonymous access and per-user MCP API keys do **not** expose
CODEBOUND scripts in this MVP: the approved execution principal needs verified
user JWT issue/expiry timestamps. Existing connector tools retain their existing
authentication behavior. Scripts are not added to `/mcp`, `/mcp/demo`, shared
discovery, or the global connector registry in this phase. No new MCP server,
database schema, dependency, model or queue is introduced.

## Discover and invoke

After connecting, call `tools/list`. Each eligible script appears with its saved
name/description and a stable tool name:

```text
codebound_script_<base64url SHA-256 of script ID>
```

Names are 59 characters, stay unchanged across revisions, and do not contain
owner IDs, organization IDs, connector IDs or source. The `codebound_script_`
namespace is reserved on the per-server endpoint: connector tools using it are
withheld there, including after a script is deleted, so a connector cannot take
over a stale script call. Duplicate script hashes are cryptographically unlikely;
this does not rely on user-chosen script titles being unique.

Invoke the returned name with the script's input directly as MCP arguments:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "<name returned by tools/list>",
    "arguments": {}
  }
}
```

Arguments never select a caller, organization, connector, tool, revision, source
or execution limit. Business fields named `userId` remain ordinary script input
when the saved schema permits them; they are never authority. Success returns
compact JSON in a text content block, with execution ID/revision in result
`_meta`. Execution failures use MCP `isError: true` with fixed text/error codes;
unknown/unlisted tools use the SDK's normal errors. The bridge adds no stack,
source, binding, decrypted configuration, raw response or internal error message
to a result. Script-selected output can contain authorized connector business
data; this is not a general data-loss-prevention or arbitrary secret-redaction
system. The gateway's credential-echo checks retain their documented limitations.

Input schemas use the existing connector JSON-Schema-to-Zod converter, preserving
top-level properties, primitive types, enums, descriptions, defaults and required
fields. `additionalProperties: false` produces a strict object; otherwise extra
business fields are retained. Complex JSON Schema constraints such as refs,
conditional/nested schemas and numeric constraints are not fully enforced by
that existing converter. All arguments still pass the shared 16 KiB bounded safe
JSON validator. Output remains at most 16 KiB. Saved output-schema semantics are
unchanged from the shared-contract MVP. There is still one connector call, no
pagination/streaming or dataset-completeness guarantee.

## Authorization and lifecycle

`CodeboundMcpToolsService` is provided by `CodeboundExecutionModule`. The existing
`McpEndpointController` resolves that application provider through `ModuleRef` to
avoid a circular module import through connectors/MCP. `McpServerService`,
`ToolRegistry` and `DynamicMcpTools` continue to serve connector tools; script calls
reuse **ScriptExecutionService**, avoiding the existing connector cache path.

The combined MCP guard authenticates first. The bridge reuses
`AuthService.verifyToken` and `resolveUserIdFromTokenPayload`, rejecting refresh,
user and machine tokens for scripts. The server's live organization/membership
determines scope, not request arguments or an active-organization JWT claim.
Discovery uses organization/owner-scoped persistence and the real
`BoundReadAuthorization` for each candidate. Discovery considers at most the first
32 owner scripts and retains at most 64 KiB of script tool metadata per surface.
There are at most four discoveries in flight per process and two per organization,
with a three-second discovery deadline. Capacity/deadline failure withholds script
tools rather than retaining an unverified surface; retry discovery when capacity
returns. Connector tools retain their existing behavior. PostgreSQL queries are
not cancellable here: an expired discovery keeps its admission slot until its
upstream work settles, and late work does not launch further authorization reads.
Larger catalogs need future pagination. Script registration closures retain
identity/revision/metadata only, not JavaScript source, output schemas or bindings.

Every invocation uses request-local authentication via AsyncLocalStorage, loads
the saved script again, checks revision/live binding authorization and delegates
to the existing execution service. Snapshot capture remains atomic. The gateway
rechecks membership, revocation, roles, grants and enabled/binding state at open
and on `api.read`. No script can gain permissions from a cached registration.
SDK cancellation and HTTP disconnect signals reach the existing orchestrator.

Stateless requests rebuild discovery from PostgreSQL. Stateful sessions keep the
existing SDK tool handles: successful create/update/delete asks
`McpSessionManager.notifyToolsChanged()` to reconcile only sessions belonging to
the affected script owner and organization, allowing the SDK's existing
list-change notifications. Existing connector lifecycle broadcasts are unchanged.
Reconciliation is coalesced per session (one active pass and a dirty flag, not an
unbounded promise queue) and
also runs before every authenticated POST in a CODEBOUND-capable session. Other
replicas therefore refresh on the next POST without a new event bus. A session
opened with one user/server/organization/OAuth-client identity cannot be reused
with a different identity or authentication method; renewed JWTs for the same
identity are accepted and current timestamps replace the session timestamps.
Reconnect when changing OAuth clients. Calls still reauthorize independently of
notifications. Idle sessions and their initialize resources retain the existing
application behavior; notification delivery is not required for safe calls.

Cloud and self-hosted use the same owner policy and execution contracts, with
existing deployment/license gates. Both fail closed when isolated Docker
execution is unavailable. No EE code changes or Cloud operator procedures are
introduced. See [execution](EXECUTION.md), [gateway](GATEWAY.md) and
[sandbox](SANDBOX.md) for inherited limits, audit/recovery and container risks.

## Exact local reproduction (PowerShell)

From the repository root, with locked dependencies installed, Node >=22.12 and
Docker using Linux containers. These are **public fixture secrets** for a
disposable test database only; never use them for a deployment:

```powershell
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
docker run --rm -d --name codebound-mcp-test -e POSTGRES_PASSWORD=codebound-test-only -e POSTGRES_DB=codebound_test -p 127.0.0.1:55520:5432 postgres:17-alpine
Set-Location packages/backend
$env:DATABASE_URL='postgresql://postgres:codebound-test-only@127.0.0.1:55520/codebound_test'
npx prisma migrate deploy
npm run build
$env:CODEBOUND_TEST_DATABASE_URL=$env:DATABASE_URL
$env:RUN_CODEBOUND_MCP_LIVE='1'
$env:DEPLOYMENT_MODE='self-hosted'
$env:MCP_AUTH_MODE='legacy'
$env:MCP_API_KEY=''
$env:MCP_BEARER_TOKEN=''
$env:REDIS_URL=''
$env:JWT_SECRET='codebound-mcp-public-fixture-jwt-secret'
$env:ENCRYPTION_KEY='codebound-mcp-public-fixture-key-32'
$env:NODE_ENV='test'
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path src/codebound/gateway/fixtures/localhost.cert.pem).Path
npm test -- --runInBand --silent --runTestsByPath src/codebound/mcp/codebound-mcp.integration.spec.ts
docker ps -aq --filter label=codebound.sandbox=true
docker stop codebound-mcp-test
```

The fixture runs the actual compiled AppModule in child Node processes to avoid
Jest's existing Node 22 CJS/ESM loader limitation. There are no provider, database,
gateway, transport or runner mocks. It creates real users, encrypted connector
credentials, saved scripts and MCP servers; sends actual MCP initialize/list/call
HTTP traffic in **stateless and stateful** modes; and verifies PostgreSQL receipts
and audit rows. The stateless scenario also uses the actual MCP SDK Client and
StreamableHTTPClientTransport for discovery and the Docker/HTTPS invocation.
It handles JSON and legacy SSE response framing.
A fault-injection case rejects lifecycle notifications before script update and
deletion; calls remain protected by live request reconciliation and authorization.
Only that notification failure is injected; execution/authentication use real services.

The fixture supplies a public static credential solely to satisfy the existing
legacy middleware configuration rule; that credential is separately shown to
have no script authority. User tokens use the real JWT signing/verification and
access-token `type`/`azp` shape. The interactive OAuth/PKCE/browser sign-in flow
is not exercised. The local HTTPS server uses the checked-in public test CA and
an explicit localhost SSRF exception only inside these fixture processes. TLS
verification stays enabled; execution-container networking stays disabled.

Coverage includes `{ "total": 11 }`, updated `{ "total": 22 }`, creation during an
active session, stable names, denied argument spoofing, other-owner/organization
denial, grants/revocation, server attachment, changed bindings, restrictive roles,
deletion, credential/source non-disclosure and no connector-name takeover. Stateful
coverage revokes the initialization JWT, rejects its replay and then invokes using
a renewed user JWT on the same session. This tests user JWT renewal, not an OAuth
refresh-token exchange. It
does not establish delivery of list-change events over every client SSE setup.
Focused security regressions also cover tenant/owner-scoped notification fan-out,
coalescing 1,000 overlapping refresh requests, discovery candidate/metadata caps,
and retaining concurrency slots for timed-out database work.

Focused regression commands from `packages/backend`:

```powershell
npm test -- --runInBand --silent --runTestsByPath src/codebound/mcp/codebound-mcp-tools.service.spec.ts src/codebound/mcp/mcp-registration.spec.ts src/codebound/persistence/script-persistence.service.spec.ts src/codebound/execution/script-execution.service.spec.ts src/mcp-server/mcp-endpoint.controller.spec.ts src/mcp-server/grant-visibility.spec.ts src/mcp-server/mcp-server.service.spec.ts src/mcp-server/tool-registry.spec.ts src/mcp-servers/mcp-session.manager.spec.ts src/auth/mcp-combined-auth.guard.spec.ts
npx tsc --noEmit -p tsconfig.json
npm run lint:check
npm run build
```

The unit tests explicitly mock database/auth policy/execution dependencies where
named. Windows Docker Desktop with Linux containers is exercised; native Linux,
macOS/arm64 and Cloud-specific sign-in/license paths remain unverified. API-key
execution, global/shared script exposure, frontend and marketplace installation
remain outside this phase.
