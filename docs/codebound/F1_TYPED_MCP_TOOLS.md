# CODEBOUND F1: typed script tools with server-scoped MCP keys

This milestone extends the existing personal script bridge on
`/mcp/:serverId`. It does **not** replace the MCP gateway or the Docker
sandbox. The existing processor chains (P1/P2) remain unchanged.

## Changes

- Per-user MCP API keys generated for a specific MCP server may discover
  and invoke owner-scoped CODEBOUND scripts. The bridge verifies the actual
  presented `mcp_...` key again against the database, including live
  `isActive`, `mcpServerId`, user identity, server organization and active
  membership. It never accepts identity from request bodies or an unverified
  `req.user`.
- Keys not assigned to the requested server, disabled keys, anonymous access,
  static bearer tokens and static API keys cannot use script tools.
- Existing JWT behavior, owner checks, current revision, connector binding
  fingerprinting, grant/role checks and Docker isolation are retained.
- Script tool names now include a stable hash of the script ID **and a readable
  suffix based on the saved script title**. The prefix is still reserved so
  connector tools cannot impersonate CODEBOUND scripts.
- JSON Schema parameters are translated through the existing Zod converter and
  exposed as MCP `inputSchema` with the expected numeric/string types.

Example of a script titled `price_drift_check`:

```text
codebound_script_<id-hash>_price_drift_check
```

A rename may change the public MCP tool name; calls made with a stale name
must reconnect/list tools again. The script ID and its saved revision remain
authoritative. User-defined suffixes are sanitized and the total name is
capped at 64 characters.

## Install the official F1 examples into the disposable test database

Prerequisites:

- The official kit setup has passed and created Alpha/Beta workspaces.
- Your isolated backend is running on localhost:4001, using the same stable
  `.env.codebound.local` encryption key established at kit setup.
- Build the updated backend and restart the isolated instance before running
  this script. No migration is required.
- The kit's state file is private and must never be committed.

From the AnythingMCP repository root:

```powershell
node scripts/install-codebound-kit-f1.mjs E:\Projs\codebound-kit\.codebound\state.json
```

The installer validates the isolated URL and workspace, logs in as the Alpha
administrator, obtains the **live authorized bindings** from
`/api/codebound/bindings`, and creates three saved scripts with proper
JSON Schema inputs:

| Script name | Required typed MCP arguments | Bound existing GET tool |
| --- | --- | --- |
| price_drift_check | threshold: number | mock_erp_list_articles |
| catalogue_total | category: string | mock_supplier_list_catalogue |
| stuck_orders | days: number, as_of: string | mock_erp_list_orders |

The example scripts are deliberately **F1-only**. They call their bound GET
tool once and report first-page information, NOT completed ERP/Supplier joins,
full pagination or order tracking. They must not be represented as F2–F4
functional solutions. Re-running the installer leaves existing same-name
scripts untouched.

Then run the official checker from `E:\Projs\codebound-kit`:

```powershell
npm run check -- --card F1
npm run check -- --card P1 --card P2
```

The first command checks F1 only. The second confirms P1/P2 remain passing.
F2–F4 require separate implementation after F1 is confirmed.

## Local backend verification

From `E:\Projs\anythingmcp-BlackForestHackathon`:

```powershell
npm run codebound:build
# Stop only the previous isolated backend on port 4001, then in its terminal:
npm run codebound:start
# Run focused tests in another terminal:
cd packages/backend
npm test -- --runInBand --runTestsByPath src/codebound/mcp/codebound-mcp-tools.service.spec.ts src/codebound/mcp/mcp-registration.spec.ts
```

Both commands load the existing root `.env.codebound.local` and explicitly
pass its variables to npm, Prisma and Nest subprocesses. They require backend
port 4001 and a localhost PostgreSQL URL on port 5434, and preserve the file's
existing `JWT_SECRET` and `ENCRYPTION_KEY`. They never rewrite `.env`, create
containers or run migrations. `codebound:start` builds first and refuses to
start after a failed build, preventing an older compiled bridge from being used.
Keep `.env.codebound.local` uncommitted. Stop the foreground test backend with
Ctrl+C when finished.

On Windows, `node --env-file=.env.codebound.local --run build:backend` was
observed to lose `DATABASE_URL` before Prisma's npm subprocess. The resulting
failed build left compiled JavaScript whose principal resolver accepted only
JWT authentication, even though the source already supported MCP API keys.
An existing server process also needs restarting after compilation.

Actual official F1 compliance requires a live check with the kit's existing
database and MCP server; unit tests mock persistence/authorization.
Cloud and self-hosted use identical authorization logic. No changes to
`ee/` or to the official `codebound-kit` repository are made.
