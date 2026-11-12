import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pages } from "@/db/schema/cms";
import { captureLead, type LeadCapture } from "@/features/leads/capture";
import { subscribeNewsletter } from "@/features/newsletter/subscribe";
import type { PageForm } from "./schema";

type FormInput = Omit<PageForm, "consent" | "website" | "captchaToken">;

const sources = { contact: "form", callback: "callback" } as const;

/**
 * A page form submit (06 §10, 09 §1): contact and callback become leads (or a new entry on
 * the person's open lead) with the visitor's attribution. The agency hears about it from the
 * lead pipeline. A newsletter form signs the address up (double opt-in).
 */
export async function handlePageForm(
  db: Db,
  input: FormInput,
  visitorKey: string | null = null,
): Promise<{ kind: "lead" | "subscriber"; leadId?: string }> {
  const [page] = input.pageId
    ? await db
        .select({ title: pages.title, slug: pages.slug })
        .from(pages)
        .where(
          and(
            eq(pages.id, input.pageId),
            eq(pages.agencyId, currentAgencyId()),
            isNull(pages.deletedAt),
          ),
        )
    : [];

  if (input.formType === "newsletter") {
    await subscribeNewsletter(db, {
      email: input.email,
      source: page ? `page:${page.slug}` : "page",
    });
    return { kind: "subscriber" };
  }

  const when = input.preferredTime;
  const task: LeadCapture["task"] =
    input.formType === "callback"
      ? { title: when ? `Call back (best time: ${when})` : "Call back", dueAt: new Date() }
      : null;

  const lead = await captureLead(db, {
    source: sources[input.formType],
    sourceDetail: input.formType === "contact" ? "contact" : "page form",
    contact: {
      name: input.name,
      email: input.email || null,
      phone: input.phone || null,
      preferredContact: input.formType === "callback" ? "call" : null,
    },
    message: input.message || null,
    details: Object.fromEntries(
      Object.entries({ page: page?.title ?? "", preferredTime: when }).filter(([, v]) => v !== ""),
    ),
    visitorKey,
    task,
  });

  return { kind: "lead", leadId: lead.leadId };
}
