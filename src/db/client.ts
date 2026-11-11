import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { cache } from "react";
import * as schema from "./schema";
import { isWorkersRuntime } from "@/lib/env";

export type Db = NodePgDatabase<typeof schema>;
/** A Drizzle transaction handle (same query API as Db). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export const DB_CASING = "snake_case" as const;

declare global {
  var __propelPool: Pool | undefined;
  var __propelDb: Db | undefined;
}

function createDb(pool: Pool): Db {
  return drizzle({ client: pool, schema, casing: DB_CASING });
}

/**
 * Node (dev server, scripts, tests): one shared pool for the process.
 * Kept on globalThis so hot reloads do not open a new pool each time.
 */
function nodeDb(): Db {
  if (globalThis.__propelDb) return globalThis.__propelDb;
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is not set. Start the local database with `pnpm db:start`.");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    // A remote database (Neon) behind NAT drops quiet connections; keep-alives keep them open.
    keepAlive: true,
    // The OS default waits hours before the first probe (2 h on Windows): too late.
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  // A connection lost while in use fails its query; without a listener it would end the process.
  pool.on("connect", (client) =>
    client.on("error", (err) => console.error("[db] client error", err.message)),
  );
  globalThis.__propelPool = pool;
  globalThis.__propelDb = createDb(pool);
  return globalThis.__propelDb;
}

/**
 * Cloudflare Workers: I/O objects cannot be shared between requests, so each request gets
 * its own small pool through Hyperdrive (which does the real pooling at the edge).
 * React `cache` dedupes it within one server render.
 */
const workersDb = cache(async (): Promise<Db> => {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = await getCloudflareContext({ async: true });
  const hyperdrive = (env as { HYPERDRIVE?: { connectionString: string } }).HYPERDRIVE;
  if (!hyperdrive) throw new Error("HYPERDRIVE binding is missing");
  const pool = new Pool({ connectionString: hyperdrive.connectionString, max: 3, maxUses: 1 });
  return createDb(pool);
});

export async function getDb(): Promise<Db> {
  return isWorkersRuntime() ? workersDb() : nodeDb();
}

/** Close the Node pool (scripts and tests). */
export async function closeDb(): Promise<void> {
  const pool = globalThis.__propelPool;
  globalThis.__propelPool = undefined;
  globalThis.__propelDb = undefined;
  if (pool) await pool.end();
}

export { schema };
