import { matchRedirect, type RedirectRule } from "./redirect-path";

/**
 * Redirects served by the middleware (08 §6), before any page renders: a streamed page starts
 * with 200 and cannot answer 301 afterwards (Next.js docs, loading -> Status codes). Each
 * instance keeps the redirects table for a few seconds, refreshes it in the background and
 * reports hits. Edge-safe: no database, no Node APIs.
 */
const FRESH_MS = 5_000;

/*
 * Only data is shared between requests, never a promise. On Workers a promise started by one
 * request never settles once that request ends, so a shared "loading" promise left every later
 * request waiting forever (pages hung with a 1101 error). Each request that needs the table
 * fetches it itself; `refreshingAt` only stops a burst of requests from all refreshing at once.
 */
let rules: Map<string, RedirectRule> | null = null;
let fetchedAt = 0;
let refreshingAt = 0;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** On Cloudflare the site reaches itself through its service binding (wrangler.jsonc). */
async function selfFetch(): Promise<Fetch> {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const { env } = await getCloudflareContext({ async: true });
      const self = (env as { WORKER_SELF_REFERENCE?: { fetch: Fetch } }).WORKER_SELF_REFERENCE;
      if (self) return (url, init) => self.fetch(url, init);
    } catch {
      /* fall back to a plain fetch */
    }
  }
  return (url, init) => fetch(url, init);
}

const auth = () => ({ authorization: `Bearer ${process.env.INTERNAL_JOB_SECRET ?? ""}` });

async function refresh(origin: string): Promise<void> {
  refreshingAt = Date.now();
  try {
    const send = await selfFetch();
    // A slow answer must not hold up the page: without the table, pages redirect themselves.
    const res = await send(`${origin}/api/internal/redirects`, {
      headers: auth(),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { rules: Array<[string, string, string, number]> };
    rules = new Map(data.rules.map(([from, id, to, status]) => [from, { id, to, status }]));
    fetchedAt = Date.now();
  } catch {
    /* keep the copy we have; pages still redirect themselves */
  }
}

export type EdgeRedirect = { location: string; status: number };

/**
 * The redirect for this request, if a rule covers it. `waitUntil` lets the background refresh
 * and the hit report finish after the response.
 */
export async function edgeRedirect(
  url: URL,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<EdgeRedirect | null> {
  const now = Date.now();
  if (!rules) await refresh(url.origin);
  else if (now - fetchedAt > FRESH_MS && now - refreshingAt > FRESH_MS)
    waitUntil(refresh(url.origin));
  if (!rules || rules.size === 0) return null;
  const found = matchRedirect(rules, url.pathname + url.search);
  if (!found) return null;
  waitUntil(
    (async () => {
      try {
        const send = await selfFetch();
        await send(`${url.origin}/api/internal/redirects`, {
          method: "POST",
          headers: { ...auth(), "content-type": "application/json" },
          body: JSON.stringify({ id: found.rule.id }),
        });
      } catch {
        /* a lost hit is not worth an error */
      }
    })(),
  );
  const location = /^https?:\/\//i.test(found.to)
    ? found.to
    : new URL(found.to, url.origin).toString();
  return { location, status: found.rule.status === 302 ? 302 : 301 };
}
