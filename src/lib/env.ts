import { z } from "zod";
import { legacyEnvNames, readEnv, type RenamedEnv } from "./legacy-env";

/**
 * Server environment. Parsed lazily so build steps that do not need a value do not fail.
 * Never import this from a Client Component: only NEXT_PUBLIC_* values reach the browser.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  PROPEL_ENV: z.enum(["development", "staging", "production"]).default("development"),
  AGENCY_ID: z.uuid().default("0192f000-0000-7000-8000-000000000001"),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.url().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** Outgoing mail over SMTP with implicit TLS (lib/email/smtp). Unset: emails stay in the log. */
  SMTP_HOST: z.string().trim().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASSWORD: z.string().optional(),

  SECRETS_ENCRYPTION_KEY: z.string().optional(),
  INTERNAL_JOB_SECRET: z.string().optional(),

  STORAGE_DRIVER: z.enum(["fs", "r2"]).default("fs"),
  /** Local media folder for the fs driver; defaults to ~/.propel/media (see lib/storage). */
  STORAGE_FS_DIR: z.string().optional(),
  JOBS_DRIVER: z.enum(["inline", "queue", "manual"]).default("inline"),
  /**
   * R2 through its S3 API, for STORAGE_DRIVER=r2 outside a Worker (the nightly demo reset in
   * GitHub Actions, a seed from a laptop). In a Worker the MEDIA_BUCKET binding is used.
   */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("propel-media"),

  /**
   * AI provider keys from the environment (local development, a server's own secrets). A key
   * saved in Settings -> Integrations wins; these are used when none is saved there.
   */
  XAI_API_KEY: z.string().trim().optional(),
  GROQ_API_KEY: z.string().trim().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  ANTHROPIC_API_KEY: z.string().trim().optional(),

  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default("1x00000000000000000000AA"),
  TURNSTILE_SECRET_KEY: z.string().default("1x0000000000000000000000000000000AA"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const source = emptyToUndefined(process.env);
  // Renamed variables: the old KEYLINE_* name still counts when the new one is not set.
  for (const name of Object.keys(legacyEnvNames) as RenamedEnv[])
    source[name] = readEnv(name, source);
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the parsed env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value === "" ? undefined : value;
  }
  return out;
}

export function isProduction(): boolean {
  return env().PROPEL_ENV === "production";
}

/** True when running inside Cloudflare Workers (OpenNext), false in Node (dev server, scripts, tests). */
export function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}
