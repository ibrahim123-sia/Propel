import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";

/**
 * OpenNext caching on Cloudflare (docs: opennext.js.org/cloudflare/caching):
 * - incremental cache (ISR, `'use cache'` entries) in R2, fronted by the regional Cache API;
 * - tag cache in sharded Durable Objects, so `revalidateTag`/`updateTag` expire exactly the
 *   entries that carry a tag (01 §4: a listing edit revalidates that listing and its searches);
 * - revalidation queue in a Durable Object.
 */
export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: "long-lived" }),
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
  queue: doQueue,
});
