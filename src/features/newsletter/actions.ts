"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { currentVisitorKey } from "@/features/attribution/current";
import { toActionError, type ActionResult } from "@/lib/actions";
import { newsletter as t } from "@/lib/i18n/dictionaries/newsletter";
import { hit, rateLimitRules } from "@/lib/rate-limit";
import { currentRequestMeta } from "@/lib/request";
import { confirmNewsletter, subscribeNewsletter, unsubscribeNewsletter } from "./subscribe";

export type FooterSignupState = { status: "idle" | "sent" | "error"; message: string };

const emailSchema = z.email().max(160);

/**
 * The footer's newsletter form (a plain form action, so it works before the page's
 * JavaScript loads). A honeypot and the per-address form rate limit keep bots out; double
 * opt-in stops anyone signing someone else up.
 */
export async function subscribeFromFooter(
  _prev: FooterSignupState,
  form: FormData,
): Promise<FooterSignupState> {
  const email = String(form.get("email") ?? "").trim();
  if (String(form.get("website") ?? "")) return { status: "sent", message: t.footer.sent };
  if (!emailSchema.safeParse(email).success) return { status: "error", message: t.footer.invalid };
  try {
    const db = await getDb();
    const meta = await currentRequestMeta();
    if (!(await hit(`form:${meta.ip ?? "unknown"}`, rateLimitRules.form, db)).allowed)
      return { status: "error", message: t.footer.busy };
    // Where the form was: the footer, or a blog post (06 §9).
    const source = form.get("source") === "blog" ? "blog" : "footer";
    await subscribeNewsletter(db, { email, source });
    return { status: "sent", message: t.footer.sent };
  } catch {
    return { status: "error", message: "Something went wrong. Please try again." };
  }
}

export async function confirmNewsletterAction(input: {
  token: string;
}): Promise<ActionResult<{ email: string }>> {
  try {
    const token = z.string().max(64).parse(input.token);
    const db = await getDb();
    const done = await confirmNewsletter(db, token, await currentVisitorKey());
    if (!done) return { ok: false, error: t.confirm.invalid, code: "NOT_FOUND" };
    return { ok: true, data: done };
  } catch (err) {
    return toActionError(err);
  }
}

export async function unsubscribeNewsletterAction(input: {
  id: string;
  token: string;
}): Promise<ActionResult<{ email: string }>> {
  try {
    const parsed = z.object({ id: z.uuid(), token: z.string().max(64) }).parse(input);
    const done = await unsubscribeNewsletter(await getDb(), parsed.id, parsed.token);
    if (!done) return { ok: false, error: t.unsubscribe.invalid, code: "NOT_FOUND" };
    return { ok: true, data: done };
  } catch (err) {
    return toActionError(err);
  }
}
