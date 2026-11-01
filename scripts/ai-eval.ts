import "./_env";
import { closeDb, getDb } from "@/db/client";
import { createProvider, setProviderOverride } from "@/features/ai/config";
import { suggestedModels } from "@/features/ai/provider-labels";
import { aiProviderNames, type AiProviderName } from "@/features/ai/types";
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
  if (provider !== "mock") setProviderOverride(createProvider(provider, apiKey));

  const agent = evalAgents.customer?.(db, world) ?? null;
  const report = await runEval({ cases: loadEvalCases(), world, db, agent });
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
