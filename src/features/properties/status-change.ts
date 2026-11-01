import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { queueListingAlerts } from "@/features/alerts/triggers";
import { properties, type PropertyStatus } from "@/db/schema/properties";
import { auditChange, type AuditActor } from "@/lib/audit";
import { refreshAutoBadges } from "./badges";
import { loadProperty, publishContextFor } from "./load";
import { publishProblems, type Problem } from "./schema";
import { isLiveStatus } from "./status";

export type StatusResult =
  | { ok: true; changed: boolean; firstPublish: boolean; projectId: string | null }
  | { ok: false; problems: Problem[] };

/**
 * Moves a listing to another status (07 §3). Going live checks the publish rules; the first
 * time sets `published_at` and remembers the price as `original_price` ("Price reduced").
 */
export async function changeStatus(
  tx: Tx,
  args: { id: string; next: PropertyStatus; actor: AuditActor; userId: string | null },
  now = new Date(),
): Promise<StatusResult> {
  const loaded = await loadProperty(tx, args.id);
  if (!loaded || loaded.row.deletedAt) return { ok: false, problems: [notFound] };
  const { row, input } = loaded;
  if (row.status === args.next)
    return { ok: true, changed: false, firstPublish: false, projectId: row.projectId };

  const publishing = isLiveStatus(args.next) && !isLiveStatus(row.status);
  if (publishing) {
    const problems = publishProblems(input, await publishContextFor(tx, input));
    if (problems.length > 0) return { ok: false, problems };
  }
  const firstPublish = publishing && row.publishedAt === null;
  const [after] = await tx
    .update(properties)
    .set({
      status: args.next,
      ...(firstPublish ? { publishedAt: now } : {}),
      ...(publishing ? { wentLiveAt: now } : {}),
      ...(publishing && row.originalPrice === null ? { originalPrice: row.price } : {}),
      updatedBy: args.userId,
    })
    .where(eq(properties.id, args.id))
    .returning();
  await auditChange(tx, {
    actor: args.actor,
    action: "property.status",
    entityType: "property",
    entityId: args.id,
    before: { status: row.status, publishedAt: row.publishedAt },
    after: { status: after!.status, publishedAt: after!.publishedAt },
  });
  await refreshAutoBadges(tx, [args.id], now);
  // 12 §3: new matches for saved searches; reserved, sold or rented for saved homes.
  if (publishing) await queueListingAlerts(tx, { kind: "live", propertyId: args.id }, now);
  await queueListingAlerts(tx, { kind: "status", propertyId: args.id, status: args.next }, now);
  return { ok: true, changed: true, firstPublish, projectId: row.projectId };
}

const notFound: Problem = {
  field: "status",
  section: "basics",
  message: "This listing no longer exists.",
};
