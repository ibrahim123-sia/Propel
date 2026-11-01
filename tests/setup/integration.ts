import { afterAll, inject } from "vitest";
import { closeDb } from "@/db/client";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.DB_POOL_MAX = "4";
// The seed uses downloaded photos when this machine has them; tests always use drawn ones.
process.env.SEED_PHOTOS_DIR = "/nonexistent/propel-seed-photos";

afterAll(async () => {
  await closeDb();
});
