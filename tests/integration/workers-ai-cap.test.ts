import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { aiUsage } from "@/db/schema/ai";
import { loadAiConfig, providerFor } from "@/features/ai/config";
import { agencyToday } from "@/features/ai/usage";
import { WORKERS_AI_DAILY_CAP_MICROS, workersAiSpentToday } from "@/features/ai/workers-ai";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { resetEnvCache } from "@/lib/env";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

const actor = { type: "admin" as const, id: testAdmin.id };
const keys = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_TOKEN", "GROQ_API_KEY"] as const;

describe("Workers AI first, within the free daily allowance", () => {
  beforeEach(async () => {
    await truncate("ai_usage", "settings", "secrets");
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_AI_TOKEN = "cf_test";
    process.env.GROQ_API_KEY = "gsk_test";
    resetEnvCache();
    await patchSettings(
      await getDb(),
      "integrations",
      {
        ai: {
          ...defaultsFor("integrations").ai,
          enabled: true,
          provider: "workers_ai",
          chatModel: "@cf/openai/gpt-oss-120b",
          fastModel: "@cf/openai/gpt-oss-20b",
          fallbackProvider: "groq",
          fallbackChatModel: "openai/gpt-oss-120b",
          fallbackFastModel: "openai/gpt-oss-20b",
        },
      },
      actor,
    );
  });
  afterEach(() => {
    for (const k of keys) delete process.env[k];
    resetEnvCache();
  });

  it("answers on Workers AI until the day's estimate reaches the cap, then on the backup", async () => {
    const db = await getDb();
    expect((await providerFor(await loadAiConfig(db), db)).name).toBe("workers_ai");

    const date = await agencyToday(db, new Date());
    await db.insert(aiUsage).values([
      // Embeddings count too: they use the same Neurons.
      { date, feature: "embeddings", model: "@cf/baai/bge-m3", costEstimateMicros: 10_000 },
      {
        date,
        feature: "customer_chat",
        model: "@cf/openai/gpt-oss-120b",
        costEstimateMicros: WORKERS_AI_DAILY_CAP_MICROS - 10_000,
      },
      // Other providers never count.
      { date, feature: "customer_chat", model: "openai/gpt-oss-120b", costEstimateMicros: 999_999 },
    ]);
    expect(await workersAiSpentToday(db)).toBe(WORKERS_AI_DAILY_CAP_MICROS);
    expect((await providerFor(await loadAiConfig(db), db)).name).toBe("groq");
  });

  it("uses the backup when the Workers AI token is missing", async () => {
    delete process.env.CLOUDFLARE_AI_TOKEN;
    resetEnvCache();
    const db = await getDb();
    expect((await providerFor(await loadAiConfig(db), db)).name).toBe("groq");
  });
});
