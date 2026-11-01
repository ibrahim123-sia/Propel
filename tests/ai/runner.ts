import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DbOrTx } from "@/db/client";
import type { EmbeddingProvider } from "@/features/ai/embeddings/provider";
import { hybridSearch, searchKnowledge } from "@/features/ai/retrieval/hybrid";
import type { EvalWorld } from "./fixtures";
import type {
  AssistantCase,
  EvalAgent,
  EvalCase,
  EvalReport,
  EvalResult,
  KnowledgeCase,
  RetrievalCase,
} from "./types";

const CASES_DIR = resolve("tests/ai/cases");

/** Every case in tests/ai/cases/*.json (ids must be unique). */
export function loadEvalCases(dir = CASES_DIR): EvalCase[] {
  const cases = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalCase[]);
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`Duplicate eval case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

async function retrieval(
  c: RetrievalCase,
  world: EvalWorld,
  db: DbOrTx,
  provider?: EmbeddingProvider,
): Promise<string[]> {
  const res = await hybridSearch({ text: c.question, filters: c.filters }, { db, provider });
  const ids = res.listings.map((l) => l.id);
  const id = (key: keyof EvalWorld["listings"]) => world.listings[key].id;
  const problems: string[] = [];
  if (c.expect.top && ids[0] !== id(c.expect.top))
    problems.push(`expected ${c.expect.top} first, got ${keyOf(world, ids[0]) ?? "nothing"}`);
  for (const k of c.expect.includes ?? []) if (!ids.includes(id(k))) problems.push(`missing ${k}`);
  for (const k of c.expect.excludes ?? [])
    if (ids.includes(id(k))) problems.push(`should not return ${k}`);
  if (c.expect.count !== undefined && ids.length !== c.expect.count)
    problems.push(`expected ${c.expect.count} results, got ${ids.length}`);
  if (c.expect.confidence && !c.expect.confidence.includes(res.confidence))
    problems.push(`confidence ${res.confidence}, expected ${c.expect.confidence.join(" or ")}`);
  // Grounding: cards carry live prices, never anything that is not public.
  const draft = world.listings.draftVilla.id;
  if (ids.includes(draft)) problems.push("returned a draft listing");
  return problems;
}

function keyOf(world: EvalWorld, id: string | undefined): string | null {
  if (!id) return null;
  return Object.entries(world.listings).find(([, v]) => v.id === id)?.[0] ?? id;
}

async function knowledge(
  c: KnowledgeCase,
  world: EvalWorld,
  db: DbOrTx,
  provider?: EmbeddingProvider,
): Promise<string[]> {
  const res = await searchKnowledge({ text: c.question, types: ["faq"] }, { db, provider });
  const problems: string[] = [];
  if (c.expect.top && res.hits[0]?.entityId !== world.faqs[c.expect.top])
    problems.push(`expected FAQ ${c.expect.top} first`);
  if (c.expect.confidence && !c.expect.confidence.includes(res.confidence))
    problems.push(`confidence ${res.confidence}, expected ${c.expect.confidence.join(" or ")}`);
  return problems;
}

/** Listing references and titles the answer names that no tool returned in this turn. */
export function ungroundedListings(
  text: string,
  toolOutputs: unknown[],
  world: EvalWorld,
): string[] {
  const seen = JSON.stringify(toolOutputs).toLowerCase();
  const said = text.toLowerCase();
  return Object.values(world.listings)
    .filter(
      (l) =>
        (said.includes(l.reference.toLowerCase()) || said.includes(l.title.toLowerCase())) &&
        !seen.includes(l.reference.toLowerCase()) &&
        !seen.includes(l.title.toLowerCase()),
    )
    .map((l) => l.reference);
}

async function assistant(c: AssistantCase, world: EvalWorld, agent: EvalAgent): Promise<string[]> {
  const turn = await agent({ question: c.question, page: c.page, history: c.history });
  const called = turn.toolCalls.map((t) => t.name);
  // AI_EVAL_VERBOSE=1: what the model did, to see why a case fails.
  if (process.env.AI_EVAL_VERBOSE)
    console.log(
      `\n--- ${c.id}: ${c.question}\n  tools: ${
        turn.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input ?? {})})`).join(", ") ||
        "(none)"
      }${turn.handedOver ? "\n  handed over" : ""}\n  answer: ${turn.text.replace(/\s+/g, " ").slice(0, 600)}`,
    );
  const problems: string[] = [];
  for (const name of c.expect.mustCallTools ?? [])
    if (!called.includes(name)) problems.push(`did not call ${name}`);
  for (const name of c.expect.mustNotCallTools ?? [])
    if (called.includes(name)) problems.push(`called ${name}`);
  for (const pattern of c.expect.mustSay ?? [])
    if (!new RegExp(pattern, "i").test(turn.text))
      problems.push(`answer does not match /${pattern}/`);
  for (const pattern of c.expect.mustNotSay ?? [])
    if (new RegExp(pattern, "i").test(turn.text)) problems.push(`answer matches /${pattern}/`);
  if (c.expect.mentionsListing) {
    const l = world.listings[c.expect.mentionsListing];
    const text = turn.text.toLowerCase();
    if (!text.includes(l.reference.toLowerCase()) && !text.includes(l.title.toLowerCase()))
      problems.push(`does not mention ${c.expect.mentionsListing}`);
  }
  // Every behaviour must stay grounded: no listing named that no tool returned.
  const invented = ungroundedListings(
    turn.text,
    turn.toolCalls.map((t) => t.output),
    world,
  );
  if (invented.length) problems.push(`named listings no tool returned: ${invented.join(", ")}`);
  if (c.expect.behaviour === "handover" && !turn.handedOver && !called.includes("request_human"))
    problems.push("did not hand over to a person");
  return problems;
}

export async function runEval(options: {
  cases: EvalCase[];
  world: EvalWorld;
  db: DbOrTx;
  agent?: EvalAgent | null;
  embeddings?: EmbeddingProvider;
}): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const c of options.cases) {
    try {
      let problems: string[];
      if (c.kind === "retrieval")
        problems = await retrieval(c, options.world, options.db, options.embeddings);
      else if (c.kind === "knowledge")
        problems = await knowledge(c, options.world, options.db, options.embeddings);
      else if (!options.agent) {
        results.push({
          id: c.id,
          kind: c.kind,
          status: "pending",
          problems: ["no assistant registered"],
        });
        continue;
      } else problems = await assistant(c, options.world, options.agent);
      results.push({
        id: c.id,
        kind: c.kind,
        status: problems.length ? "fail" : "pass",
        problems,
      });
    } catch (err) {
      results.push({ id: c.id, kind: c.kind, status: "fail", problems: [(err as Error).message] });
    }
  }
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const pending = results.filter((r) => r.status === "pending").length;
  return {
    results,
    passed,
    failed,
    pending,
    passRate: passed + failed ? passed / (passed + failed) : 1,
  };
}

export function formatReport(report: EvalReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "....".padEnd(4)} ${r.id.padEnd(5)} ${r.kind.padEnd(9)} ${r.problems.join("; ")}`,
  );
  lines.push(
    "",
    `${report.passed} passed, ${report.failed} failed, ${report.pending} pending: pass rate ${(report.passRate * 100).toFixed(1)}%`,
  );
  return lines.join("\n");
}
