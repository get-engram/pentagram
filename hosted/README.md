# pentagram-hosted

Pentagram as a service: **one Durable Object per tenant** — the platform
guarantees the single-writer invariant (DOs are single-threaded) and gives
each tenant an isolated SQLite log. Embeddings run on Workers AI
(`bge-small-en-v1.5`, 384-dim); no external API keys.

```
Claude / any MCP agent
        │  POST /mcp  (Authorization: Bearer <key>)
        ▼
   edge worker ── key→tenant ──► PentagramTenant DO (per tenant)
                                   ├── SqlLogBackend (DO SQLite: log + aux)
                                   ├── Store (same core as local pentagram)
                                   └── Workers AI embeddings
```

## Deploy

```sh
cd hosted
npm install
npx wrangler deploy
npx wrangler secret put API_KEYS   # "key1:tenant1,key2:tenant2"
```

## Connect

```sh
claude mcp add --transport http pentagram-cloud https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer <key>"
```

## Status

MVP. Deliberate limits, matching the core's honesty policy:

- The `eval` tool has full language access **within its tenant** — structural
  isolation between tenants, unrestricted inside one. Resource limits on
  eval are still TODO before offering this to untrusted parties.
- Consolidation uses the extractive summarizer (no LLM calls server-side yet);
  entity extraction is off. Wiring Workers AI text generation into a
  Summarizer/Extractor is the natural next step.
- Parquet compaction is a file-backend capability; DO archives live in the
  aux table until an R2 export lands.
- API keys are a flat var/secret; real auth (per-key rate limits, provisioning
  API, dashboard) is the productization step, not this MVP.
