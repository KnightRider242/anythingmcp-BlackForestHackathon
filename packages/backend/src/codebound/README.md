# CODEBOUND shared contracts

These contracts are AGPL-3.0-only and apply equally to Cloud and self-hosted
deployments. It includes shared validation and an unregistered Docker sandbox
adapter. No authorization, persistence, API route, MCP tool, or UI is registered.
See `docs/codebound/README.md` at the repository root for sandbox tests and limits.

## MVP boundary

- One saved JavaScript script, one connector, one backend-approved REST GET tool,
  at most one connector call, and at most 16 KiB of serialized UTF-8 JSON output.
- Source defines `async function main(input, api)` and calls `api.read(arguments)`.
  A single call establishes no streaming, pagination, or dataset-completeness guarantee.
- Personal owner-only execution is a temporary MVP policy. Marketplace-installed
  scripts remain in delivery scope; their final ownership model is not defined here.
- Snapshots are detached and recursively frozen by `parseScriptSnapshot`.
  Revisions are positive safe integers; persistence must enforce atomic version
  comparisons. Live authorization must still be revalidated for every operation.
- Connector calls require cache bypass until the independently tested tenant,
  caller, and nested-argument cache fix is proven. No cache code is changed here.

## Validation boundaries

`contracts.validation.ts` uses the existing Zod dependency for strict message
shapes and bounded plain JSON. `ScriptExecutionRequestDto` uses the repository's
class-validator/class-transformer pattern for future HTTP controllers, with
`whitelist: true` and `forbidNonWhitelisted: true`. Identity and policy are not
accepted in this DTO. Authenticate first; construct principals in trusted code.

The IPC reader must limit bytes while buffering, before JSON parsing. The frame
parser also checks complete-frame size. Treat rejected frames as fatal for that
execution. Never forward Zod errors containing untrusted field names or internal
exceptions directly to clients; map to bounded, sanitized `CodeboundError` values.

JSON validation rejects non-finite numbers, unsupported objects, cycles,
accessors, sparse arrays, dangerous keys, depth over 32 and over 50,000 nodes.
It clones accepted values. This is for parsed data, not arbitrary JavaScript
objects with hostile proxies. Input/output schema fields are bounded JSON
documents only; validating JSON Schema semantics and validating script output
against the saved schema remain future integration requirements.

`MVP_LIMITS` is the maximum policy. Trusted code may lower ceilings. Execution
consumers must enforce the selected limits, including lower output/connector
response caps, not only the static maximum validators. The supervisor must
measure usage independently, enforce single-call accounting and process limits,
cancel upstream work, kill/reap containers and invalidate sessions. Shape
validation alone does not enforce these runtime properties or redact secrets.

`SANDBOX_UNAVAILABLE` means fail closed: never execute source in the application
process. The intended runner uses disposable isolated containers with no direct
network, host mounts, application credentials, or Docker socket. No infrastructure
is created by these contracts. Existing deployment and license checks still apply.

Persistence must follow the repository's issue-before-schema-change and migration
process. Script CRUD, gateway, sandbox, MCP, UI and marketplace hooks are separate
implementation steps after contract review.
