import { env } from "@/lib/env";
import type { SmtpConfig } from "./smtp";

/** The mail server from the environment, or null when it is not set (emails then stay in the log). */
export function smtpFromEnv(): SmtpConfig | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = env();
  if (!SMTP_USER || !SMTP_PASSWORD) return null;
  // Gmail shows app passwords in groups of four; the spaces are not part of it.
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    password: SMTP_PASSWORD.replace(/\s+/g, ""),
  };
}
