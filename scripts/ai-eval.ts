import "./_env";
import { closeDb, getDb } from "@/db/client";
import { createProvider, setProviderOverride } from "@/features/ai/config";
import { suggestedModels } from "@/features/ai/provider-labels";
import {
  AiProviderError,
  aiProviderNames,
  type AiProvider,
  type AiProviderName,
} from "@/features/ai/types";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { evalAgents } from "../tests/ai/agents";
import { seedEvalWorld } from "../tests/ai/fixtures";
import { formatReport, loadEvalCases, runEval } from "../tests/ai/runner";
import { startTestDatabase } from "./test-db";

/**
 * `pnpm ai:eval`: runs the eval set (tests/ai/cases) against a throwaway in-memory database
 * with the fictional eval world, and prints the pass rate (10 §6: run it before changing
 * prompts or models).
 *
 * The built-in test provider is used unless a real one is asked for explicitly:
 *   AI_EVAL_PROVIDER=groq|gemini|xai|anthropic [AI_EVAL_API_KEY=...] [AI_EVAL_MODEL=<id>] pnpm ai:eval
 * The key defaults to the provider's env key (GROQ_API_KEY, GEMINI_API_KEY, ...), the model to
 * its suggested chat model. That spends real money; tests and CI never set it.
 * AI_EVAL_MIN_PASS (0-1, default 1) sets the pass rate below which the command fails.
 */

const asked = process.env.AI_EVAL_PROVIDER ?? "";
const provider: AiProviderName | "mock" = (aiProviderNames as readonly string[]).includes(asked)
  ? (asked as AiProviderName)
  : "mock";
const envKeys: Record<AiProviderName, string | undefined> = {
  xai: process.env.XAI_API_KEY,
  groq: process.env.GROQ_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};
const apiKey = provider === "mock" ? "" : (process.env.AI_EVAL_API_KEY ?? envKeys[provider] ?? "");
if (provider !== "mock" && !apiKey) {
  console.error(`AI_EVAL_PROVIDER=${provider} needs AI_EVAL_API_KEY or its env key.`);
  process.exit(1);
}
const model =
  process.env.AI_EVAL_MODEL ?? (provider === "mock" ? undefined : suggestedModels[provider].chat);
const minPass = Number(process.env.AI_EVAL_MIN_PASS ?? 1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Free API tiers (Groq: 8,000 tokens a minute; Gemini: a few requests a minute) answer 429
 * long before the eval is done. The eval waits as long as the provider says ("try again in
 * 4.1s"), or 20 s, and asks again, up to 12 times per call; the site itself does not wait.
 */
function patient(inner: AiProvider): AiProvider {
  const waitFor = (err: unknown) => {
    if (!(err instanceof AiProviderError) || err.status !== 429) return null;
    const s =
      /try again in ([\d.]+)\s*s/i.exec(err.message) ?? /retry in ([\d.]+)\s*s/i.exec(err.message);
    return Math.min(60_000, Math.ceil((s ? Number(s[1]) : 20) * 1000) + 500);
  };
  return {
    name: inner.name,
    async complete(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.complete(req);
        } catch (err) {
          const wait = waitFor(err);
          if (wait === null || attempt >= 12) throw err;
          await sleep(wait);
        }
      }
    },
    async *stream(req) {
      for (let attempt = 0; ; attempt++) {
        let started = false;
        try {
          for await (const e of inner.stream(req)) {
            started = true;
            yield e;
          }
          return;
        } catch (err) {
          const wait = waitFor(err);
          if (started || wait === null || attempt >= 12) throw err;
          await sleep(wait);
        }
      }
    },
  };
}

process.env.JOBS_DRIVER = "manual";
process.env.SECRETS_ENCRYPTION_KEY ??= "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // eval only
const database = await startTestDatabase();
process.env.DATABASE_URL = database.url;
let failed = false;
try {
  const db = await getDb();
  const world = await seedEvalWorld(db);
  const system = { type: "system" as const, id: null };
  const integrations = await loadSettings("integrations", db);
  await patchSettings(
    db,
    "integrations",
    {
      ai: {
        ...integrations.ai,
        enabled: true,
        provider,
        fallbackProvider: "none",
        ...(model ? { chatModel: model, fastModel: model } : {}),
      },
    },
    system,
  );
  if (provider !== "mock") setProviderOverride(patient(createProvider(provider, apiKey)));

  const agent = evalAgents.customer?.(db, world) ?? null;
  // AI_EVAL_ONLY=C01,C07: just these cases (with AI_EVAL_VERBOSE=1 to see the answers).
  const only = (process.env.AI_EVAL_ONLY ?? "").split(",").filter(Boolean);
  const cases = loadEvalCases().filter((c) => only.length === 0 || only.includes(c.id));
  const report = await runEval({ cases, world, db, agent });
  console.log(`[ai:eval] provider: ${provider}${model ? ` (${model})` : ""}\n`);
  console.log(formatReport(report));
  failed = report.passRate < minPass;
} catch (err) {
  console.error("[ai:eval] failed:", err);
  failed = true;
} finally {
  await closeDb();
  await database.stop();
}
process.exit(failed ? 1 : 0);
