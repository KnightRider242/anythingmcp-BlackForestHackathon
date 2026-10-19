# CODEBOUND + Open Food Facts: live public catalogue workflow

This **opt-in** demo demonstrates CODEBOUND running against changing, real
public product catalogue records. Unlike the original F2–F4 hackathon checks,
it requires **no official test kit or mock ERP/Supplier/Carrier servers**.
It does need an existing configured and running AnythingMCP + CODEBOUND
application, your own authenticated dashboard account, and working Docker
sandbox execution.

**No real product purchases, supplier price, stock, order or shipping data is
available through this integration.** The script reports a bounded sample of
food product metadata and nutrition-field completeness, not a supplier price
comparison, health recommendation or full-population statistics.

## Architecture

```text
Authenticated CODEBOUND saved script / MCP tool
      ├─ approved REST GET: off_search_products
      │      └─ https://world.openfoodfacts.org/api/v2/search
      │         structured categories + bounded pagination + fixed fields
      └─ approved REST GET: off_get_product
             └─ https://world.openfoodfacts.org/api/v2/product/{code}.json
                selected public product fields
      ↓
CODEBOUND authorized connector gateway → HTTPS + SSRF and access checks
      ↓
Ephemeral no-network Docker worker joins, computes and validates JSON
      ↓
Compact sample analytics → MCP/UI + Runs & Insights audit receipt
```

The source is in `scripts/codebound-openfoodfacts-workflow.mjs`.
`main.toString()` is saved as immutable CODEBOUND source and runs **only**
inside CODEBOUND's existing isolated worker (the unit tests call the
trusted authored `main` function directly). No direct `fetch` or network
calls are made from inside the sandbox.

## Prerequisites

1. Use this fork with CODEBOUND from `main` plus the feature branch/PR.
2. Complete the supported **host-mode source** setup in
   [PORTABLE_SETUP.md](PORTABLE_SETUP.md), then start:
   `npm run codebound:dev`.
3. Confirm the local backend health endpoint responds at the configured
   `PORT`, and register/sign into your own dashboard account.
4. Docker Linux containers, the `codebound-sandbox:mvp` image and PostgreSQL
   must already be available. The installer does not start, stop or reset them.
5. Keep this separate from an official `codebound-kit` fixture installation.
   In particular, do **not** run the installer against the isolated kit
   port-4001 database unless you deliberately migrate that environment
   outside the official test harness.

The installer refuses a backend URL that does not match the localhost PORT in
the fork's existing development `.env`. It will not contact a remote backend,
alter `.env`, rotate secrets, create test users, or reset PostgreSQL.

## Provision the approved tools and workflow

From the **repository root**:

```bash
node scripts/install-codebound-openfoodfacts.mjs --dry-run
```

To authenticate, set only the following **temporary shell environment**
variables (never save them to the repository or pass passwords as command-line
flags):

```bash
read -r -p 'Dashboard email: ' CODEBOUND_DEMO_EMAIL
read -r -s -p 'Dashboard password: ' CODEBOUND_DEMO_PASSWORD
printf '\n'
export CODEBOUND_DEMO_EMAIL CODEBOUND_DEMO_PASSWORD

node scripts/install-codebound-openfoodfacts.mjs --install

unset CODEBOUND_DEMO_EMAIL CODEBOUND_DEMO_PASSWORD
```

PowerShell equivalent (enter the password at the hidden prompt, **not** as the
prompt text):

```powershell
$env:CODEBOUND_DEMO_EMAIL = Read-Host -Prompt "Dashboard email"
$pw = Read-Host -Prompt "Dashboard password" -AsSecureString
$env:CODEBOUND_DEMO_PASSWORD = [System.Net.NetworkCredential]::new("", $pw).Password
Remove-Variable pw

node scripts/install-codebound-openfoodfacts.mjs --dry-run
node scripts/install-codebound-openfoodfacts.mjs --install

Remove-Item Env:CODEBOUND_DEMO_PASSWORD, Env:CODEBOUND_DEMO_EMAIL
```

The installer calls these existing authenticated endpoints:

- `POST /api/auth/login` (unless you set `CODEBOUND_DEMO_TOKEN`)
- `POST /api/connectors/import-all` (one public `REST` connector, two
  `GET` tools, fixed endpoint mappings, custom User-Agent)
- `GET /api/codebound/bindings` (live backend-issued fingerprints)
- `POST /api/codebound/scripts` (saved source + approved bindings)
- `POST /api/mcp-servers` and `PUT /api/mcp-servers/:id/connectors`
  (a dedicated demo MCP server only)

The resulting demo server is named **CODEBOUND Public Catalogue**, with
slug `codebound-public-catalogue`. It is separate from your existing MCP
servers and connector assignments. No MCP API key is created by the installer.

Reruns skip matching connectors/scripts/server configurations. They refuse
ambiguous or modified existing definitions rather than overwriting user work.
`--update` explicitly requests a revision-aware update of the saved
workflow after inspection; `--skip-server` installs the script for
**dashboard-only** execution without creating an MCP server.

**Permissions:** the user must have connector creation, server creation,
and access to both approved tools. If an endpoint responds with HTTP 403,
check role/membership/license policy. Connector names are fixed and unique
per organization for this opt-in demo.

## First run

Open `http://localhost:3000/scripts` (adjust frontend host if configured),
choose `openfoodfacts_catalogue_audit`, and use:

```json
{
  "categories": ["breakfast-cereals", "yogurts"],
  "pagesPerCategory": 1,
  "pageSize": 12,
  "detailLimit": 2,
  "sugarThreshold": 20
}
```

The script fetches at most **two categories × two search pages per category**,
with at most **20 results per page**, and makes at most **three extra barcode
lookups**. Therefore no more than **seven read requests** are issued by one
run (four search + three product detail). The default is two searches and two
detail reads. It never calls the raw URL directly, selects arbitrary tool
IDs, changes headers or submits writes.

The output includes:

- `reportedCatalogueCount`: the API's estimated matching records in that
  category. **Not** the number processed in the sampled run.
- `sampledProducts`, `pagesFetched`, and `completeCatalogue`: explicit
  coverage and truncation indicators.
- `sugarGPer100g`: values present in the sampled product metadata, including
  missing-value counts and averages **among only sampled products with
  numeric values**.
- `nutriscoreGradeCounts`: counts for observed sample products, not a
  diagnosis or safety ranking.
- `topSugarSamples`: up to five sampled product records by sugar
  per 100g, *not* the highest-sugar products in the full catalogue.
- `detailSamples`: metadata completeness and a few allergen/label tags for
  selected barcodes using the second tool.
- `sourceRequests`: tool-call counts used by the demo (the dashboard records
  trusted transport metrics separately).

Visit `/scripts/runs` and compare **connector response bytes** to
**output bytes**. Any percentage reduction is *potential model-facing
payload reduction*, not measured model tokens, inference costs, network
savings or guaranteed business impact.

The Open Food Facts API can change. A real run has not been confirmed
until your local CODEBOUND dashboard shows status **SUCCEEDED** and the
external HTTPS requests are visible in the execution metrics.

## API etiquette, licensing and limitations

Open Food Facts documents approximately:

- **10 search requests/minute/IP**
- **15 product-detail requests/minute/IP**

The script bounds calls **per run**, but CODEBOUND does not impose
per-provider cross-run quotas. Do not repeatedly execute it in quick
succession or run concurrent demos against the same shared IP: wait at least
**60 seconds** between complete demo runs, and respect HTTP 429/503
responses. This is a low-volume demonstration, not a catalogue crawler.

The connector uses a descriptive custom `User-Agent`, fixed
`Accept: application/json`, no credentials, and **only HTTPS GET**.
The search tool uses explicit `fields` to reduce response size.
HTTP errors, unexpected API shapes, and rate limiting can fail the run;
it does not silently substitute fixture data. Product details are looked
up only using barcodes obtained from a prior authorized search.

Open Food Facts is crowd-sourced and does not guarantee accuracy or
completeness. Data/database licensing requires attribution and can require
share-alike treatment for derivative databases (**ODbL**).
The response attributes the source; verify the applicable licensing and
terms before publishing or combining full datasets commercially.
No product images are copied.

References:

- https://openfoodfacts.github.io/openfoodfacts-server/api/
- https://openfoodfacts.github.io/documentation/docs/Product-Opener/v2/search/get-search/
- https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/
- https://world.openfoodfacts.org/terms-of-use

## Test and troubleshoot

```bash
node --check scripts/codebound-openfoodfacts-workflow.mjs
node --check scripts/install-codebound-openfoodfacts.mjs
node --test scripts/codebound-openfoodfacts-workflow.test.mjs
node scripts/install-codebound-openfoodfacts.mjs --dry-run
```

These tests use deterministic **mocked API responses** and verify the
aggregation, input/call limits and plain-JSON output contract. They make
**zero external API calls**. A separate manual live execution is necessary
to validate actual upstream compatibility.

- `403` while installing: account is not an authorized connector owner,
  editor/admin or may lack license capability.
- Missing bindings: check the imported tool definitions, HTTPS base URL,
  active status and ownership. This gateway does not approve arbitrary
  tools or URL selection by scripts.
- `SANDBOX_UNAVAILABLE`: ensure this is a host-running CODEBOUND backend
  with a working Docker daemon and the sandbox image built.
- `CONNECTOR_ERROR`: check Open Food Facts reachability, TLS trust, rate
  limits and request volume; never weaken SSRF/TLS checks as a workaround.
- MCP tool not listed: use the dedicated `/mcp/<serverId>`, create an
  authenticated server-bound user key or valid JWT with appropriate grants,
  and refresh tool discovery.
