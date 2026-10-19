# CODEBOUND runs & insights (post-hackathon feature branch)

Branch: `feat/codebound-runs-insights`. **Do not merge without local typecheck, tests and browser verification.**
This is a follow-up iteration; the original submitted `main` branch remains unchanged.

## Changes

- **Editor correction:** The script save payload now preserves existing `additionalBindings` and lets users intentionally add/remove approved secondary tools. All bindings are still reauthorized by the backend, including definition fingerprints. The "GET only / one call" description is corrected.
- **History API:** Authenticated `GET /api/codebound/runs` and `GET /api/codebound/runs?afterId=<executionId>`. Pages contain at most 25 receipts with an opaque ID cursor. The endpoint validates that the cursor itself is owned by the current user in their active organization.
- **Privacy:** Only status, timestamps, revision, workflow name (if still present), duration, connector-call count, aggregate connector bytes, output bytes and sanitized error code/limit are returned. No script source, inputs, connector bodies, secrets, raw errors, environment or tool credentials are returned. Deleting a script can leave its metadata-only receipt; display name then becomes "Deleted script".
- **UI:** `/scripts/runs` shows status, filters, refresh/load-more, per-run metrics, failure explanations and rule-based insights. Its overview summarizes only currently loaded successful runs. A run recorded as `RUNNING` can remain visible after an interruption until backend recovery is triggered; it is not a live log stream.
- **Diagnostics:** Rules explain denied access, resource limits, upstream failures and worker unavailability without invoking an LLM or transferring history outside the backend.

## How the reduction metric works

For each successful run:

`potential_reduction_bytes = max(0, connectorResponseBytes - outputBytes)`

For the loaded successful run set:

`potential_reduction_percent = sum(potential_reduction_bytes) / sum(connectorResponseBytes) * 100`

This measures reduction **between aggregate connector responses and the final workflow output**. It does **not** measure actual LLM token use, model API cost, memory allocation, end-to-end latency, or network transfer from the enterprise systems to the gateway. Failed runs are excluded, and zero-byte baselines are shown as N/A. Repeated calls can inflate the raw baseline. A valid before/after LLM benchmark must separately count token usage and final-answer quality.

## Local verification (isolated port-4001 kit)

Keep the original AnythingMCP service on port 4000 and its database untouched. Do not rerun the official kit setup or reset Docker volumes.

1. Ensure local edits are committed/stashed safely, then fetch/switch to the feature branch.
2. From the fork root:
   - `npx tsc --noEmit -p packages/frontend/tsconfig.json`
   - `npx eslint packages/frontend/src/app/scripts/page.tsx packages/frontend/src/app/scripts/runs/page.tsx packages/frontend/src/lib/api.ts packages/frontend/src/components/app-sidebar.tsx`
3. From `packages/backend`:
   - `npx tsc --noEmit -p tsconfig.json`
   - `npm test -- --runInBand --testPathPatterns='script-persistence.service.spec'`
4. Restart only the isolated CODEBOUND backend after building it; restart the local Next.js frontend with its backend proxy still pointing to `http://127.0.0.1:4001`.
5. Read-only API check from the fork root:
   - `node scripts/verify-codebound-runs.mjs E:/Projs/codebound-kit/.codebound/state.json`
6. In the browser: `http://localhost:3000/scripts/runs`. Verify run statuses and history; sign into Bob/Beta in a separate browser and confirm he sees none of Alice's receipts.
7. Regression test for Save: in Alice/Alpha, select `price_drift_check`, confirm both ERP and Supplier are listed under approved tools, make a harmless description edit, Save, Reload and confirm both bindings remain. Then rerun `npm run check -- --card F2` from the official kit root. This test creates a new saved revision but does not modify mock data.

## Known limitations / next iteration

- No actual per-step worker logs, source snapshots, input/output payloads, execution replay or server-sent live status events are stored by this API. An Actions-style timeline here is based on receipts, not fabricated logs.
- The database currently applies per-process concurrency limits (2 global / 1 per owner) with no distributed queue. Production requires dedicated workers, quotas, retries, alerting and multi-host rollout.
- Current smart insights are deterministic rules. Optional AI explanations and natural-language workflow generation must be designed so that no secrets or private connector content are sent to the model; require human approval for generated executable source and connector grants.
- History pagination covers most recent receipts in pages of 25, with no workspace-admin overview and no aggregated all-time SQL endpoint. The sidebar and metrics are owner scoped.
- The original self-hosted backend must retain trusted Docker supervisor access. Do not mount a privileged Docker socket into the ordinary frontend or app container as a shortcut.
