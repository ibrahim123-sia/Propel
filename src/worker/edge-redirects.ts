import { Client } from "pg";
import { matchRedirect, type RedirectRule } from "../features/seo/redirect-path";

/**
 * Redirects (08 §6) on Cloudflare, answered by the Worker before Next.js runs, straight from
 * the database through Hyperdrive.
 *
 * They used to come from the middleware, which fetched /api/internal/redirects from the Worker
 * itself. That request ran in the same isolate at the same time as the page that asked for it,
 * so on a fresh isolate both started Next.js together and one waited on the other's start-up
 * promise; on Workers a promise settled by another request never wakes the one waiting, so the
 * page hung, and every later page in that isolate hung the same way (Error 1101, 2026-11-28).
 * Nothing here is shared between requests except plain data.
 */

type Hyperdrive = { connectionString: string };
type Ctx = { waitUntil(p: Promise<unknown>): void };

const FRESH_MS = 60_000;
const QUERY_TIMEOUT_MS = 3_000;
const AGENCY_ID = () => process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";

let rules: Map<string, RedirectRule> | null = null;
let fetchedAt = 0;

/** Pages Next.js never redirects: the admin, the customer area, APIs and build files. */
const SKIP = /^\/(?:admin|account|api|_next|media|favicon|robots\.txt|sitemap)/;

async function withClient<T>(hyperdrive: Hyperdrive, run: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: hyperdrive.connectionString,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function loadRules(hyperdrive: Hyperdrive): Promise<void> {
  try {
    const { rows } = await withClient(hyperdrive, (c) =>
      c.query<{ id: string; from_path: string; to_path: string; type: number }>(
        "select id, from_path, to_path, type from seo_redirects where agency_id = $1",
        [AGENCY_ID()],
      ),
    );
    rules = new Map(rows.map((r) => [r.from_path, { id: r.id, to: r.to_path, status: r.type }]));
    fetchedAt = Date.now();
  } catch (err) {
    // Keep the copy we have; pages still redirect themselves.
    console.error("[redirects] could not load the table:", (err as Error).message);
    fetchedAt = Date.now();
  }
}

/** The redirect response for this request, or null to let Next.js serve it. */
export async function workerRedirect(
  request: Request,
  env: { HYPERDRIVE?: Hyperdrive },
  ctx: Ctx,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (SKIP.test(url.pathname) || !env.HYPERDRIVE) return null;
  if (!rules || Date.now() - fetchedAt > FRESH_MS) await loadRules(env.HYPERDRIVE);
  if (!rules || rules.size === 0) return null;
  const found = matchRedirect(rules, url.pathname + url.search);
  if (!found) return null;
  const hyperdrive = env.HYPERDRIVE;
  ctx.waitUntil(
    withClient(hyperdrive, (c) =>
      c.query(
        "update seo_redirects set hits = hits + 1, last_hit_at = now() where id = $1 and agency_id = $2",
        [found.rule.id, AGENCY_ID()],
      ),
    ).catch(() => undefined),
  );
  const location = /^https?:\/\//i.test(found.to)
    ? found.to
    : new URL(found.to, url.origin).toString();
  return new Response(null, {
    status: found.rule.status === 302 ? 302 : 301,
    headers: { location, "cache-control": "no-store" },
  });
}
