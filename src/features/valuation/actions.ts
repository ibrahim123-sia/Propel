"use server";

import type { z } from "zod";
import { getDb } from "@/db/client";
import { currentVisitorKey } from "@/features/attribution/current";
import { errorsByPath, toActionError, type ActionResult } from "@/lib/actions";
import { valuation as t } from "@/lib/i18n/dictionaries/valuation";
import { hit, rateLimitRules } from "@/lib/rate-limit";
import { currentRequestMeta } from "@/lib/request";
import { verifyTurnstile } from "@/lib/turnstile";
import { PhotoRefused, ownerPhotoRateRule, startOwnerPhoto } from "./photos";
import {
  ownerPhotoUploadSchema,
  valuationRequestSchema,
  type OwnerRequestResult,
  type ValuationRequestInput,
} from "./schema";
import { submitOwnerRequest } from "./submit";

/**
 * The public valuation form (11 §5): validated on the server, honeypot, a per-IP rate limit and
 * Turnstile, like every public form (14 §2). Bots that fill the honeypot get a plain
 * "thank you" and nothing is stored.
 */
export async function sendValuationRequest(
  input: ValuationRequestInput,
): Promise<ActionResult<OwnerRequestResult>> {
  const kind = "valuation";
  try {
    const parsed = valuationRequestSchema.safeParse(input);
    if (!parsed.success) {
      const { fieldErrors, formErrors } = errorsByPath(parsed.error);
      return { ok: false, error: formErrors[0] ?? t.errors.check, code: "VALIDATION", fieldErrors };
    }
    const data = parsed.data;
    if (data.website)
      return {
        ok: true,
        data: { kind, agentName: "", areaName: "", email: null, estimate: null },
      };
    const db = await getDb();
    const meta = await currentRequestMeta();
    const limit = await hit(`form:${meta.ip ?? "unknown"}`, rateLimitRules.form, db);
    if (!limit.allowed) return { ok: false, error: t.errors.tooMany, code: "RATE_LIMITED" };
    if (!(await verifyTurnstile(data.captchaToken, meta.ip, "owner-request")))
      return { ok: false, error: t.errors.captcha, code: "CAPTCHA" };
    const {
      requestId: _r,
      leadId: _l,
      ...result
    } = await submitOwnerRequest(db, kind, data, {
      visitorKey: await currentVisitorKey(),
    });
    return { ok: true, data: result };
  } catch (err) {
    return toActionError(err);
  }
}

/** Step 4: a signed link to upload one photo (features/valuation/photos.ts). */
export async function startOwnerPhotoUpload(
  input: z.input<typeof ownerPhotoUploadSchema>,
): Promise<ActionResult<{ id: string; uploadUrl: string }>> {
  try {
    const parsed = ownerPhotoUploadSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: t.photos.failed, code: "VALIDATION" };
    const db = await getDb();
    const meta = await currentRequestMeta();
    const limit = await hit(`owner-photo:${meta.ip ?? "unknown"}`, ownerPhotoRateRule, db);
    if (!limit.allowed) return { ok: false, error: t.errors.tooMany, code: "RATE_LIMITED" };
    return { ok: true, data: await startOwnerPhoto(db, parsed.data) };
  } catch (err) {
    if (err instanceof PhotoRefused) return { ok: false, error: err.message, code: "REFUSED" };
    return toActionError(err);
  }
}
