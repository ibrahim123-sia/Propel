import "server-only";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { customerPreferences, savedSearches } from "@/db/schema/customer";
import { readPreferenceToken, unsubscribeTokenHash, type PreferenceKind } from "./tokens";

export type UnsubscribeResult =
  { kind: "search"; name: string } | { kind: PreferenceKind } | { kind: "invalid" };

/**
 * One-click unsubscribe (12 §3) from an alert email: `token` switches one saved search off,
 * `pref` stops one kind of saved-home email. Repeating it is harmless.
 */
export async function unsubscribe(
  db: DbOrTx,
  input: { token?: string | null; pref?: string | null },
): Promise<UnsubscribeResult> {
  if (input.token && /^[A-Za-z0-9_-]{32}$/.test(input.token)) {
    const [row] = await db
      .update(savedSearches)
      .set({ alertFrequency: "off" })
      .where(
        and(
          eq(savedSearches.agencyId, currentAgencyId()),
          eq(savedSearches.unsubscribeTokenHash, await unsubscribeTokenHash(input.token)),
        ),
      )
      .returning({ name: savedSearches.name });
    return row ? { kind: "search", name: row.name } : { kind: "invalid" };
  }
  if (input.pref) {
    const found = await readPreferenceToken(input.pref);
    if (!found) return { kind: "invalid" };
    const off = { email: false, whatsapp: false };
    await db
      .insert(customerPreferences)
      .values({ userId: found.userId, [found.kind]: off })
      .onConflictDoUpdate({
        target: customerPreferences.userId,
        set: { [found.kind]: off, updatedAt: new Date() },
      });
    return { kind: found.kind };
  }
  return { kind: "invalid" };
}
