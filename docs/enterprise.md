# Pentagram Enterprise

**Auditable, self-hosted memory for AI agents. Runs in your cloud. We never see your data.**

---

## The problem

Your teams are deploying AI agents, and agents without memory repeat questions,
lose context, and can't learn your business. So teams bolt on memory — usually
a hosted memory API or an improvised vector store. That creates two problems
procurement and risk teams are now catching:

1. **Agent memory is your most sensitive data.** It is a distillation of
   everything your people told the AI — customers, deals, incidents,
   decisions — accumulating in a third-party cloud under a startup's ToS.
2. **Nobody can answer "why did the agent know that?"** When an AI system
   acts on remembered information, governance requires tracing that memory to
   its source. Vector stores can't; they store fragments with no history.

## What Pentagram is

Pentagram is an open-source (MIT) memory substrate for AI systems, built on a
deliberately asymmetric two-layer architecture:

- **An exact layer** — an append-only, immutable event log. Every memory,
  every link, every recall, every consolidation is a permanent, timestamped
  record. The log *is* the database and the audit trail.
- **An associative layer** — semantic recall (local embeddings), a knowledge
  graph of entities and relationships, and human-like memory dynamics:
  frequently used memories strengthen, stale ones decay, and a scheduled
  "sleep cycle" consolidates old episodes into summarized facts that cite
  their sources.

Agents connect over the Model Context Protocol (MCP) — Claude, or any
MCP-capable agent, gets `remember` / `recall` / graph traversal as native
tools, per-tenant isolated.

## Why it is different

- **Sovereignty by default.** Self-hosted in your VPC. Embeddings run
  locally; no external API calls are required to operate. Your memories
  never leave your perimeter — which also means your existing compliance
  posture covers them.
- **Audit-grade provenance.** Every consolidated fact cites the episodes it
  came from; every recall that shaped the system's behavior is in the log.
  "What did the system believe on March 3rd, and why?" is a query, not a
  forensics project.
- **No lock-in, ever.** The live log is human-readable; cold history compacts
  to Parquet that Snowflake, Databricks, or DuckDB query directly. Your data
  platform team needs zero integration work, and leaving is `cp`.
- **Memory semantics, not just storage.** Reinforcement, decay, forgetting,
  and consolidation are built into the engine — the behaviors teams otherwise
  hand-build (inconsistently) on top of a vector database.
- **Small, inspectable core.** Zero-dependency TypeScript your security team
  can actually read, with an MIT license and a published design paper.

## Enterprise offering (design-partner program)

The core is free forever. Design partners get, and shape:

- Deployment tooling (Docker/Kubernetes), SSO/RBAC, encryption at rest
- Priority support with SLAs, direct access to the maintainer
- Roadmap influence, security-review support, source escrow available
- Annual license, sized to deployment scope

We are selecting **3 design partners** now — teams deploying AI agents who
need memory their auditors, security reviewers, and regulators can live with.

**Contact:** Debra Gail · debragailinc@gmail.com · npm: `pentagram-db`
