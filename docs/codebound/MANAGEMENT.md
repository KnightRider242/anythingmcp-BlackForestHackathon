# Script management (Milestone 5B)

Open **Build → CODEBOUND Scripts** (`/scripts`) after signing in. Create a
script, select an owned REST GET tool, edit `async function main(input, api)`,
and save. Run accepts a JSON object and executes the saved revision only.
Unsaved changes disable Run. Results are rendered as text, never HTML.
The editor supports bounded input/output schema documents; full JSON Schema
semantics remain pending. Use `api.read({})` once and return a compact result:

```js
async function main(input, api) {
  const data = await api.read(input);
  return { count: Array.isArray(data) ? data.length : Object.keys(data).length };
}
```

Choose arguments appropriate for the bound tool. No pagination, streaming or
complete dataset coverage is implied. Source is limited to 32 KiB, input to
16 KiB, connector response to 512 KiB and output to 16 KiB. Do not paste secrets
into scripts, schemas or input. Input/output and unrestricted history are not
persisted by these endpoints. The existing run endpoint returns bounded output
to its authenticated owner.

## HTTP API

All routes below use `Authorization: Bearer <dashboard JWT>`, the existing
`AuthGuard('jwt')`, and its live active organization. Caller/user/organization
fields are rejected in bodies and queries. Successful responses are
`{ok:true,value}`; service errors are `{ok:false,error:{code,message}}` with
400 invalid request, 403 forbidden, 404 missing/inaccessible script, 409 revision
conflict or 500 sanitized internal failure. Existing JWT failures return 401.

| Route | Request | Value |
| --- | --- | --- |
| `GET /api/codebound/scripts` | optional `?afterId=…` | at most 20 owned script snapshots |
| `GET /api/codebound/scripts/:id` | — | own script snapshot |
| `POST /api/codebound/scripts` | `{definition}` | revision 1 snapshot (HTTP 201) |
| `PUT /api/codebound/scripts/:id` | `{expectedRevision,definition}` | updated snapshot |
| `DELETE /api/codebound/scripts/:id` | `{expectedRevision}` JSON body | `null` |
| `GET /api/codebound/bindings` | optional `?afterId=…` | `{items,nextCursor}` |
| `POST /api/codebound/scripts/execute` | `{scriptId,expectedRevision,input}` | existing terminal receipt/result |

`definition` is the existing shared ScriptDefinition: name, description, source,
inputSchema, outputSchema and binding `{connectorId,toolId,definitionSha256}`.
Use the picker-provided fingerprint. The persistence service computes source
hashes and rechecks live binding authorization on create/update. Execution
rechecks independently. Updating a connector can invalidate existing bindings;
refresh tools and save again. Reload script explicitly after a revision conflict;
the UI keeps local edits until reload. Delete is confirmed and uses the saved
revision. Receipts retain existing deletion semantics.

The picker examines at most 32 owned active REST tool candidates per request
and calls the real BoundReadAuthorization for each. Denied/write/proxy tools
are omitted. The cursor advances over denied candidates; an empty page can
still have a nextCursor. Returned fields are only connectorName, toolName and
binding IDs/fingerprint. No URLs, credentials, headers, config or environment
variables are returned. Transport-specific validity (HTTPS, mapping shape,
SSRF policy, argument compatibility) is still enforced by the existing restricted
executor when running; discovery is not a connectivity test.

## Local setup and checks

Follow root AGENTS.md setup with PostgreSQL on 5433, existing migrations and
Prisma generation. Build the sandbox image from root:

```sh
docker build -f deploy/codebound/Dockerfile -t codebound-sandbox:mvp .
npm run dev
```

Visit `http://localhost:3000/scripts`, using an owned supported HTTPS REST GET
connector. No changes to database schema or dependencies are needed. The same
management API/UI applies in Cloud and self-hosted deployments. Execution still
requires the isolated runner described in [SANDBOX.md](SANDBOX.md); unavailable
isolation fails closed. No deployment-mode auth bypass is introduced.

Backend, from `packages/backend`:

```sh
npm test -- --runInBand --silent --runTestsByPath src/codebound/management/script-management.spec.ts src/codebound/persistence/script-persistence.service.spec.ts src/codebound/execution/script-execution.service.spec.ts src/codebound/execution/script-execution.controller.spec.ts
npx tsc --noEmit -p tsconfig.json
npm run lint:check
npm run build
```

For real database/API and Docker/HTTPS tests follow [EXECUTION.md](EXECUTION.md)'s
dedicated disposable database environment and flags, build backend first, then:

```sh
npm test -- --runInBand --silent --runTestsByPath src/codebound/execution/app-wiring.integration.spec.ts src/codebound/execution/script-execution.integration.spec.ts
```

AppModule smoke verifies CRUD, revisions, forged identity rejection, owned tool
selection, cross-owner/cross-organization denial and disabled tools using actual
JWT guards, services and PostgreSQL with no provider overrides. The execution
integration creates through the management API and executes with actual Docker,
PostgreSQL and a controlled HTTPS connector. It uses an explicitly assembled
Nest module with real services. UI tests mock HTTP and do not constitute a
browser-to-live-connector integration test.

Frontend, from `packages/frontend`, with normal dev server stopped:

```sh
npx playwright install --with-deps chromium
npx playwright test tests/e2e/codebound-scripts.spec.ts tests/e2e/network-drop.spec.ts tests/e2e/redesign.spec.ts
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run build
```

The tests manage a Next server on 3100. Personal owner-only execution remains
an MVP restriction. Marketplace script installation and frontend run history
are outside this milestone. MCP compatibility remains as documented in
[MCP.md](MCP.md), including its user JWT/per-server verification limits.

## Validation recorded for this change

- Backend focused unit tests: 52 passed; full AppModule PostgreSQL smoke: 1
  passed; Docker/PostgreSQL/HTTPS execution suite: 13 passed. The updated
  API-create-to-execution scenario was also rerun individually and passed.
- Backend catalog: 8,843 passed. Adapter validation: 490 passed, 0 failed,
  1,458 pre-existing warnings; count check passed. No adapter files changed.
- Chromium: 10 passed (4 Scripts tests plus existing auth/navigation tests).
  The initial run could not launch because Chromium was missing; installing
  it resolved that prerequisite. Accessible editor/error labels were corrected
  after the first browser run.
- Backend and frontend TypeScript and production builds passed. Full lint
  passed with 14 backend and 26 frontend warnings in existing files; focused
  lint of changed TypeScript/TSX files passed without warnings.
- The existing redesign tests also emitted backend-unavailable health-proxy
  messages and a Next dev runtime React-version warning despite passing. The
  resolved frontend react/react-dom packages are both 19.3.0; no dependency
  changes were made. Production build succeeded, with only expected missing
  Sentry-upload-token warnings. Windows host with Linux Docker was exercised;
  Linux/macOS hosts were not separately tested.
