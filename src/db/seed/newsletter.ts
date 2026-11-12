import { eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import { contacts, newsletterSubscribers } from "../schema/crm";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";

const system = { type: "system" as const, id: null };
const day = 86_400_000;

/**
 * Demo newsletter (05 §13): the footer signup is on, and a handful of fictional subscribers
 * in each state (confirmed, waiting for confirmation, unsubscribed). Addresses that belong to
 * demo contacts are linked to them.
 */
export async function seedNewsletter(db: Db, { now }: { now: Date }): Promise<void> {
  const website = await loadSettings("website", db);
  await patchSettings(db, "website", { footer: { ...website.footer, newsletter: true } }, system);
  const people = [
    { email: "amira.k@example.com", source: "footer", daysAgo: 52, confirmed: true },
    { email: "j.whitfield@example.com", source: "page:about", daysAgo: 40, confirmed: true },
    { email: "noor.hassan@example.com", source: "footer", daysAgo: 33, confirmed: true },
    {
      email: "daniel.ortiz@example.com",
      source: "page:off-plan-guide",
      daysAgo: 21,
      confirmed: true,
    },
    { email: "mei.lin@example.com", source: "footer", daysAgo: 12, confirmed: true },
    { email: "tom.becker@example.com", source: "footer", daysAgo: 2, confirmed: false },
    {
      email: "priya.n@example.com",
      source: "footer",
      daysAgo: 60,
      confirmed: true,
      unsubscribedDaysAgo: 9,
    },
  ];
  const known = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      inArray(
        contacts.email,
        people.map((p) => p.email),
      ),
    );
  const contactOf = new Map(known.map((c) => [c.email, c.id]));
  for (const p of people) {
    const signedUp = new Date(now.getTime() - p.daysAgo * day);
    await db.insert(newsletterSubscribers).values({
      email: p.email,
      source: p.source,
      contactId: contactOf.get(p.email) ?? null,
      createdAt: signedUp,
      confirmedAt: p.confirmed ? new Date(signedUp.getTime() + 20 * 60_000) : null,
      unsubscribedAt: p.unsubscribedDaysAgo
        ? new Date(now.getTime() - p.unsubscribedDaysAgo * day)
        : null,
    });
    const contactId = contactOf.get(p.email);
    if (contactId && p.confirmed && !p.unsubscribedDaysAgo)
      await db
        .update(contacts)
        .set({ marketingConsent: true, marketingConsentAt: signedUp })
        .where(eq(contacts.id, contactId));
  }
}
