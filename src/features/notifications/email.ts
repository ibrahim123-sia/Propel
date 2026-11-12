import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DbOrTx } from "@/db/client";
import { emailLog } from "@/db/schema/system";
import { loadSettings } from "@/features/settings/queries";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { sendSmtp, type SmtpConfig } from "@/lib/email/smtp";
import { smtpFromEnv } from "@/lib/email/config";
import { newId } from "@/lib/ids";

export type OutgoingEmail = {
  to: string;
  subject: string;
  /** Template name, for the log and reports (e.g. "auth.verify-email"). */
  template: string;
  html: string;
  text: string;
  replyTo?: string;
  related?: { type: string; id: string };
  /** Extra headers, e.g. List-Unsubscribe on alerts (12 §3). */
  headers?: Record<string, string>;
};

/**
 * Logs the email and queues `email.send` (13 §2: sending is a job with retries and stored
 * status). Returns the email log id.
 */
export async function queueEmail(email: OutgoingEmail, db?: DbOrTx): Promise<string> {
  const conn = db ?? (await getDb());
  const id = newId();
  await conn.insert(emailLog).values({
    id,
    to: email.to.toLowerCase(),
    subject: email.subject,
    template: email.template,
    html: email.html,
    text: email.text,
    status: "queued",
    provider: "mock",
    relatedType: email.related?.type ?? null,
    relatedId: email.related?.id ?? null,
  });
  await enqueue(
    "email.send",
    { emailId: id, replyTo: email.replyTo ?? null, headers: email.headers ?? null },
    { db: conn, dedupeKey: `email:${id}` },
  );
  return id;
}

type SenderConfig = { smtp: SmtpConfig; from: string; fromAddress: string; replyTo: string | null };

/**
 * The mail server comes from the environment (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD;
 * Worker secrets in production); the sender name and reply-to from Settings -> Integrations.
 */
async function senderConfig(db: DbOrTx): Promise<SenderConfig | null> {
  const smtp = smtpFromEnv();
  if (!smtp) return null;
  const { email } = await loadSettings("integrations", db);
  const name = email.fromName || (await loadSettings("general", db)).agencyName;
  return {
    smtp,
    from: `${name.replace(/[<>"]/g, "")} <${smtp.user}>`,
    fromAddress: smtp.user,
    replyTo: email.replyTo || null,
  };
}

export const emailSendJob = defineJob({
  name: "email.send",
  payload: z.object({
    emailId: z.uuid(),
    replyTo: z.string().nullable().default(null),
    headers: z.record(z.string(), z.string()).nullable().default(null),
  }),
  maxAttempts: 5,
  async run({ emailId, replyTo, headers }, { db, log }) {
    const [row] = await db.select().from(emailLog).where(eq(emailLog.id, emailId)).limit(1);
    if (!row) return { skipped: "missing" };
    if (row.status === "sent" || row.status === "mocked") return { skipped: row.status };

    const config = await senderConfig(db);
    if (!config) {
      // No provider configured (development, demo, tests): keep the email in the log only.
      await db
        .update(emailLog)
        .set({ status: "mocked", provider: "mock", sentAt: new Date(), error: null })
        .where(eq(emailLog.id, emailId));
      log("email mocked (no provider)", { template: row.template, to: row.to });
      return { provider: "mock" };
    }
    try {
      const providerId = await sendSmtp(config.smtp, {
        id: emailId,
        from: config.from,
        fromAddress: config.fromAddress,
        to: row.to,
        subject: row.subject,
        html: row.html ?? "",
        text: row.text ?? "",
        replyTo: replyTo ?? config.replyTo,
        headers,
      });
      await db
        .update(emailLog)
        .set({ status: "sent", provider: "smtp", providerId, sentAt: new Date(), error: null })
        .where(eq(emailLog.id, emailId));
      return { provider: "smtp", providerId };
    } catch (err) {
      await db
        .update(emailLog)
        .set({ status: "failed", provider: "smtp", error: (err as Error).message.slice(0, 1000) })
        .where(eq(emailLog.id, emailId));
      throw err;
    }
  },
});
