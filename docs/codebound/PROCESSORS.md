# CODEBOUND Level 1: Declarative processor chains

The existing AnythingMCP tool execution path supports optional `responseMapping.processorChain`.
It runs **after the connector has returned data and before the existing response mapping**.
Processor chains never evaluate user-supplied JavaScript and do not receive credentials,
network access, or a process environment. The processor works on copies of the
upstream response: any invalid row fails the whole tool call, without returning
raw or partially processed data. The no-chain path leaves existing tools alone.

## Configuration

Save the chain through the existing authenticated
`PUT /api/connectors/:connectorId/tools/:toolId` endpoint as part of the tool's
`responseMapping`. The endpoint validates the chain and reloads the connector
tool registry. This uses the existing JSON mapping column; no migration is required.

```json
{
  "processorChain": {
    "itemsField": "items",
    "steps": [
      { "operation": "multiply", "input": "price_usd", "output": "price_eur", "factor": 0.92, "decimals": 2, "mode": "add" },
      { "operation": "multiply", "input": "price_eur", "output": "price_eur_gross", "factor": 1.19, "decimals": 2, "mode": "add" },
      { "operation": "normalizeWhitespace", "input": "description", "output": "description", "mode": "replace" }
    ]
  }
}
```

`multiply` requires numeric input and rounds after every step (using
`Math.round(value * factor * 10 ** decimals) / 10 ** decimals`).
`normalizeWhitespace` requires a string, trims it and reduces runs of whitespace
to one space. `add` refuses an existing output field and `replace` refuses a
missing output field. Input and output paths are single safe field names.
A chain is limited to eight steps and 10,000 array items. Invalid inputs name
the offending field (for example `items[0].price_usd`).

The configured processor applies to both cache hits and fresh connector results.
The sandboxed JavaScript execution feature is separate; this Level 1 chain uses
a restricted data-only DSL.

## Official codebound-kit: configure isolated Alpha workspace

After the official kit has completed `npm run setup -- --url
http://localhost:4001 --mode host`, and **after building and restarting** the
new backend, run this from the AnythingMCP repository root:

```powershell
node scripts/configure-codebound-kit-processors.mjs E:\Projs\codebound-kit\.codebound\state.json
```

The helper reads the kit's locally generated state, authenticates as the Alpha
administrator, and sets the chain on **only** the Alpha Mock Supplier offers tool.
It refuses production-style addresses and port 4000. It preserves other
response mapping settings, avoids logging credentials, and uses the existing
authenticated tool update API. Do not publish the kit's state file.

Then from `E:\Projs\codebound-kit`:

```powershell
npm run check -- --card P1 --card P2
```

This targets only P1 and P2. F1–F4 are a separate milestone; this change does
not add multi-tool scripts or change the CODEBOUND sandbox's execution limits.

## Safety and deployments

Cloud and self-hosted deployments both require an authenticated tool-owner edit
to set `processorChain`. Existing tools are unchanged. All input processing is
bounded, non-executable, and synchronous. Processor errors fail the tool call
instead of disclosing raw data. Do not use this helper against the main/demo
database; the official kit is designed for an isolated test environment.
