import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { seoRedirects } from "@/db/schema/seo";
import { workerRedirect } from "@/worker/edge-redirects";
import { truncate } from "../helpers/db";

/**
 * Redirects on Cloudflare are answered by the Worker before Next.js, from the database
 * (src/worker/edge-redirects.ts), never by the Worker fetching itself.
 */
describe("Worker redirects", () => {
  const env = { HYPERDRIVE: { connectionString: process.env.DATABASE_URL! } };

  beforeEach(async () => {
    await truncate("seo_redirects");
  });

  it("answers a moved address with its 301 and counts the hit", async () => {
    const db = await getDb();
    const [rule] = await db
      .insert(seoRedirects)
      .values({ fromPath: "/old-listing", toPath: "/rent", type: 301 })
      .returning({ id: seoRedirects.id });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };

    const res = await workerRedirect(
      new Request("https://propel.example/old-listing?utm_source=x"),
      env,
      ctx,
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("https://propel.example/rent?utm_source=x");
    await Promise.all(waits);
    const [row] = await db.select().from(seoRedirects).where(eq(seoRedirects.id, rule!.id));
    expect(row!.hits).toBe(1);

    expect(await workerRedirect(new Request("https://propel.example/rent"), env, ctx)).toBeNull();
    expect(
      await workerRedirect(
        new Request("https://propel.example/old-listing", { method: "POST" }),
        env,
        ctx,
      ),
    ).toBeNull();
    expect(
      await workerRedirect(new Request("https://propel.example/admin/x"), env, ctx),
    ).toBeNull();
  });
});
