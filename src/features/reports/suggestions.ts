import "server-only";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { latestChatTopics } from "@/features/ai/topics";
import { liveStatuses } from "@/features/properties/status";
import { format } from "@/lib/i18n";
import { reports as t } from "@/lib/i18n/dictionaries/reports";
import { agency, num } from "./context";
import type { ReportContext } from "./types";

/**
 * Suggestion cards on the dashboard (10 §3 "Suggest"): what deserves attention today, from
 * fixed SQL (no model, so they cost nothing and are always right). A card only links to the
 * list or record where the admin acts; changes made with the assistant go through its confirm
 * flow (01 §1.8).
 */
export type DashboardSuggestion = {
  id: string;
  title: string;
  body: string;
  /** An admin address the card opens (a lead, a listing, a filtered list). */
  href?: string;
  actionLabel?: string;
  tone?: "info" | "warning";
};

/** A listing is priced above similar homes when its price per area is this much over theirs. */
export const OVERPRICED_RATIO = 1.25;
/** Similar homes needed before comparing (same area and type, for sale, live). */
export const MIN_COMPARABLES = 3;
/** Verification older than this many days needs a check (07 §3 trust block). */
export const VERIFY_DAYS = 30;
const HOT_SCORE = 70;

const live = sql.raw(`(${liveStatuses.map((s) => `'${s}'`).join(",")})`);

export type SuggestionCounts = {
  hotNoViewing: number;
  toVerify: number;
  noPhotos: number;
  missingSeo: number;
  overpriced: Array<{ id: string; reference: string; title: string; pct: number }>;
};

export async function suggestionCounts(db: DbOrTx): Promise<SuggestionCounts> {
  const res = await db.execute<{
    hot: number;
    verify: number;
    photos: number;
    seo: number;
  }>(sql`
    select
      (select count(*)::int from leads l
        where l.agency_id = ${agency()} and l.status = 'open' and l.merged_into_id is null
          and l.ai_score >= ${HOT_SCORE}
          and not exists (select 1 from viewings v where v.lead_id = l.id)) as hot,
      (select count(*)::int from properties p
        where p.agency_id = ${agency()} and p.deleted_at is null and p.status in ${live}
          and (not p.is_verified or p.last_verified_at is null
            or p.last_verified_at < now() - make_interval(days => ${VERIFY_DAYS}))) as verify,
      (select count(*)::int from properties p
        where p.agency_id = ${agency()} and p.deleted_at is null and p.status in ${live}
          and not exists (select 1 from property_media m
            where m.property_id = p.id and m.kind = 'photo')) as photos,
      (select count(*)::int from properties p
        where p.agency_id = ${agency()} and p.deleted_at is null and p.status in ${live}
          and (coalesce(p.seo_title, '') = '' or coalesce(p.seo_description, '') = '')) as seo`);
  const r = res.rows[0]!;

  // Price per area against the median of the same area and type (for sale, live, ready or not).
  const priced = await db.execute<{ id: string; reference: string; title: string; ratio: number }>(
    sql`
    with sale as (
      select p.id, p.reference, p.title, p.location_id, p.property_type_id, p.price_per_area::float8 as ppa
      from properties p
      where p.agency_id = ${agency()} and p.deleted_at is null and p.status in ${live}
        and p.purpose = 'sale' and p.price_per_area > 0
    )
    select s.id, s.reference, s.title, s.ppa / m.median as ratio
    from sale s
    cross join lateral (
      select percentile_cont(0.5) within group (order by o.ppa) as median, count(*) as n
      from sale o
      where o.id <> s.id and o.location_id = s.location_id
        and o.property_type_id = s.property_type_id
    ) m
    where m.n >= ${MIN_COMPARABLES} and m.median > 0 and s.ppa / m.median >= ${OVERPRICED_RATIO}
    order by ratio desc
    limit 3`,
  );
  return {
    hotNoViewing: num(r.hot),
    toVerify: num(r.verify),
    noPhotos: num(r.photos),
    missingSeo: num(r.seo),
    overpriced: priced.rows.map((p) => ({
      id: p.id,
      reference: p.reference,
      title: p.title,
      pct: Math.round((Number(p.ratio) - 1) * 100),
    })),
  };
}

export async function loadDashboardSuggestions(
  db: DbOrTx,
  _ctx: ReportContext,
): Promise<DashboardSuggestion[]> {
  const s = t.suggestions;
  const c = await suggestionCounts(db);
  const cards: DashboardSuggestion[] = [];
  if (c.hotNoViewing > 0)
    cards.push({
      id: "hot-no-viewing",
      title: format(c.hotNoViewing === 1 ? s.hotOne : s.hotMany, { n: c.hotNoViewing }),
      body: s.hotBody,
      href: `/admin/leads?smin=${HOT_SCORE}&status=open`,
      actionLabel: s.hotAction,
      tone: "warning",
    });
  for (const p of c.overpriced)
    cards.push({
      id: `overpriced-${p.id}`,
      title: format(s.overpricedTitle, { reference: p.reference, pct: p.pct }),
      body: format(s.overpricedBody, { title: p.title }),
      href: `/admin/properties/${p.id}`,
      actionLabel: s.overpricedAction,
      tone: "info",
    });
  if (c.toVerify > 0)
    cards.push({
      id: "verify",
      title: format(c.toVerify === 1 ? s.verifyOne : s.verifyMany, { n: c.toVerify }),
      body: format(s.verifyBody, { days: VERIFY_DAYS }),
      href: `/admin/properties?verifiedOlder=${VERIFY_DAYS}`,
      actionLabel: s.verifyAction,
      tone: "info",
    });
  if (c.noPhotos > 0)
    cards.push({
      id: "no-photos",
      title: format(c.noPhotos === 1 ? s.photosOne : s.photosMany, { n: c.noPhotos }),
      body: s.photosBody,
      href: "/admin/properties?noPhotos=1",
      actionLabel: s.photosAction,
      tone: "info",
    });
  if (c.missingSeo > 0)
    cards.push({
      id: "missing-seo",
      title: format(c.missingSeo === 1 ? s.seoOne : s.seoMany, { n: c.missingSeo }),
      body: s.seoBody,
      href: "/admin/properties?missingSeo=1",
      actionLabel: s.seoAction,
      tone: "info",
    });
  // 10 §3: a blog topic from the week's common chat questions (the weekly grouping, 10 §5).
  const topic = (await latestChatTopics(db))?.topics.find((x) => x.blogIdea);
  if (topic)
    cards.push({
      id: "blog-topic",
      title: format(s.topicTitle, { idea: topic.blogIdea! }),
      body: format(topic.count === 1 ? s.topicBodyOne : s.topicBodyMany, {
        n: topic.count,
        label: topic.label,
      }),
      href: "/admin/website/blog",
      actionLabel: s.topicAction,
      tone: "info",
    });
  // Keep the column short: the most useful few.
  return cards.slice(0, 6);
}
