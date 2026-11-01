import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { localDataPath } from "./paths";
import { startTestDatabase } from "./test-db";

/**
 * Starts everything the Playwright suite needs:
 *  1. a fresh in-memory database (all migrations applied) on E2E_DB_PORT (default 5434);
 *  2. Next.js on E2E_PORT (default 3200), in its own build folder so a normal `pnpm dev`
 *     can keep running. E2E_MODE=prod builds and runs the production server (CI);
 *     E2E_SKIP_BUILD=1 reuses the last production build.
 */
const dbPort = Number(process.env.E2E_DB_PORT ?? 5434);
const appPort = Number(process.env.E2E_PORT ?? 3200);
const mode = process.env.E2E_MODE === "prod" ? "prod" : "dev";
const appUrl = `http://localhost:${appPort}`;

const db = await startTestDatabase({ port: dbPort });
console.log(`[e2e] database ready: ${db.url}`);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: db.url,
  DB_POOL_MAX: "5",
  APP_URL: appUrl,
  BETTER_AUTH_URL: appUrl,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-0123456",
  SECRETS_ENCRYPTION_KEY:
    process.env.SECRETS_ENCRYPTION_KEY ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  INTERNAL_JOB_SECRET: process.env.INTERNAL_JOB_SECRET ?? "e2e-internal-secret",
  PROPEL_ENV: "development",
  JOBS_DRIVER: "inline",
  STORAGE_DRIVER: "fs",
  STORAGE_FS_DIR: localDataPath("e2e-media"),
  // Many sign-ins from one IP in a short run; the limits themselves are covered by integration tests.
  RATE_LIMITS: "off",
  TURNSTILE_SECRET_KEY: "off",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "off",
  // Brochure PDFs use fallback fonts: tests never reach Google Fonts.
  BROCHURE_WEB_FONTS: "off",
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
};

// Run Next's JS entry with this Node binary: no shell, so no argument-escaping issues on Windows.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const children: ChildProcess[] = [];
function next(args: string[]): ChildProcess {
  const child = spawn(process.execPath, [nextBin, ...args], { env, stdio: "inherit" });
  children.push(child);
  return child;
}

async function shutdown(code = 0) {
  for (const c of children) c.kill();
  await db.stop().catch(() => undefined);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (mode === "prod") {
  // E2E_SKIP_BUILD=1 serves the last build in .next-e2e (repeat runs against unchanged code).
  if (process.env.E2E_SKIP_BUILD !== "1") {
    const build = next(["build"]);
    const code: number = await new Promise((r) => build.on("exit", (c) => r(c ?? 1)));
    if (code !== 0) await shutdown(code);
  }
  next(["start", "--port", String(appPort)]);
} else {
  next(["dev", "--port", String(appPort)]);
}
