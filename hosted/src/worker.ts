// The edge worker: authenticates, resolves the tenant, forwards MCP traffic
// to that tenant's Durable Object. One DO per tenant = structural isolation
// plus platform-guaranteed single-writer.
//
//   POST /mcp   — MCP streamable-HTTP: one JSON-RPC message per request
//   Auth        — Authorization: Bearer <key>; keys map to tenants via the
//                 API_KEYS var/secret: "key1:tenant1,key2:tenant2"
//
// Connect from Claude Code:
//   claude mcp add --transport http pentagram-cloud https://<worker>/mcp \
//     --header "Authorization: Bearer <key>"

export { PentagramTenant } from "./tenant-do.js";

interface Env {
  PENTAGRAM: any; // DurableObjectNamespace
  AI?: any;
  API_KEYS?: string; // "key:tenant,key:tenant" — use a secret in production
}

function tenantFor(env: Env, request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key || !env.API_KEYS) return null;
  for (const pair of env.API_KEYS.split(",")) {
    const [k, tenant] = pair.trim().split(":");
    if (k === key && tenant && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant)) return tenant;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "⛧ pentagram-hosted — memory for AI agents.\nPOST /mcp with Authorization: Bearer <key>.\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const tenant = tenantFor(env, request);
    if (!tenant) return new Response("unauthorized", { status: 401 });

    const id = env.PENTAGRAM.idFromName(tenant);
    return env.PENTAGRAM.get(id).fetch(request);
  },
};
