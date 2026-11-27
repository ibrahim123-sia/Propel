import { lt, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db/client";
import { rateLimits } from "@/db/schema/system";

/**
 * Fixed-window rate limits stored in Postgres (14-non-functional.md §2), shared by every
 * Worker isolate. Keys look like `form:<ip>` or `chat-day:<visitorId>`.
 */
export type RateLimitRule = { limit: number; windowSeconds: number };

export const rateLimitRules = {
  form: { limit: 5, windowSeconds: 60 },
  chatMinute: { limit: 20, windowSeconds: 60 },
  chatDay: { limit: 200, windowSeconds: 86_400 },
  tool: { limit: 30, windowSeconds: 60 },
  /** Site beacons per (truncated) IP: page views, listing views, clicks. */
  track: { limit: 120, windowSeconds: 60 },
  /** 404 reports per (truncated) IP (the not-found page's beacon). */
  notFound: { limit: 30, windowSeconds: 60 },
  login: { limit: 5, windowSeconds: 60 },
  loginFailures: { limit: 5, windowSeconds: 900 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitResult = { allowed: boolean; count: number; limit: number; resetAt: Date };

export function rateLimitsDisabled(): boolean {
  return process.env.RATE_LIMITS === "off";
}

/** Counts one hit and reports whether it is within the limit. */
export async function hit(
  key: string,
  rule: RateLimitRule,
  db?: DbOrTx,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const resetAt = new Date(windowStart + windowMs);
  if (rateLimitsDisabled()) return { allowed: true, count: 0, limit: rule.limit, resetAt };

  const conn = db ?? (await getDb());
  const [row] = await conn
    .insert(rateLimits)
    .values({ key: `${key}:${windowStart}`, count: 1, expiresAt: resetAt })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  const count = row?.count ?? 1;
  return { allowed: count <= rule.limit, count, limit: rule.limit, resetAt };
}

/** Blocks `key` until the given time (login lockout). */
export async function lock(key: string, until: Date, db?: DbOrTx): Promise<void> {
  const conn = db ?? (await getDb());
  await conn
    .insert(rateLimits)
    .values({ key: `lock:${key}`, count: 1, expiresAt: until })
    .onConflictDoUpdate({ target: rateLimits.key, set: { expiresAt: until } });
}

export async function lockedUntil(
  key: string,
  db?: DbOrTx,
  now: Date = new Date(),
): Promise<Date | null> {
  if (rateLimitsDisabled()) return null;
  const conn = db ?? (await getDb());
  const [row] = await conn
    .select({ expiresAt: rateLimits.expiresAt })
    .from(rateLimits)
    .where(sql`${rateLimits.key} = ${`lock:${key}`}`)
    .limit(1);
  return row && row.expiresAt > now ? row.expiresAt : null;
}

/** Removes counters and locks for a key (e.g. after a successful login). */
export async function clearKey(key: string, db?: DbOrTx): Promise<void> {
  const conn = db ?? (await getDb());
  await conn
    .delete(rateLimits)
    .where(sql`${rateLimits.key} = ${`lock:${key}`} or ${rateLimits.key} like ${`${key}:%`}`);
}

/** Nightly clean-up. */
export async function purgeExpired(db?: DbOrTx, now: Date = new Date()): Promise<number> {
  const conn = db ?? (await getDb());
  const removed = await conn
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, now))
    .returning({ key: rateLimits.key });
  return removed.length;
}
