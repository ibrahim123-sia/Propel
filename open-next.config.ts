import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";

const r2Cache = withRegionalCache(r2IncrementalCache, { mode: "long-lived" });
type IncrementalCache = Pick<typeof r2Cache, "name" | "get" | "set" | "delete">;

/**
 * Pages with a postponed (partial prerender) shell are never served from the cache. Resuming
 * a stored shell hung on Workers: the headers went out with `x-nextjs-postponed: 1` and the
 * body never started (agent, blog and property pages; /buy and /rent before). Treated as a
 * miss, the page renders in one pass, which worked every time; its data still comes from the
 * `'use cache'` entries, and fully static pages are still served from the cache.
 */
const withoutPostponedShells = (cache: IncrementalCache): IncrementalCache => ({
  name: `${cache.name}-without-postponed-shells`,
  async get(key, cacheType) {
    const entry = await cache.get(key, cacheType);
    const value = entry?.value as { type?: string; meta?: { postponed?: string } } | undefined;
    if (value?.type === "app" && value.meta?.postponed) return null;
    return entry;
  },
  async set(key, value, cacheType) {
    const page = value as { type?: string; meta?: { postponed?: string } };
    if (page.type === "app" && page.meta?.postponed) return;
    await cache.set(key, value, cacheType);
  },
  delete: (key) => cache.delete(key),
});

/**
 * OpenNext caching on Cloudflare (docs: opennext.js.org/cloudflare/caching):
 * - incremental cache (ISR, `'use cache'` entries) in R2, fronted by the regional Cache API;
 * - tag cache in sharded Durable Objects, so `revalidateTag`/`updateTag` expire exactly the
 *   entries that carry a tag (01 §4: a listing edit revalidates that listing and its searches);
 * - revalidation queue in a Durable Object.
 */
export default defineCloudflareConfig({
  incrementalCache: withoutPostponedShells(r2Cache),
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
  queue: doQueue,
});
