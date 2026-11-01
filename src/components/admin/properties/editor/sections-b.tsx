"use client";

import { BadgeCheckIcon } from "lucide-react";
import { useState } from "react";
import { AiButton, paragraphsToDoc } from "@/components/admin/ai/ai-button";
import { aiEditDescription, aiSuggestSeo, aiWriteDescription } from "@/features/ai/helper-actions";
import type { PropertyInput } from "@/features/properties/schema";
import {
  CheckboxListField,
  ListField,
  SwitchField,
  TextInputField,
} from "@/components/admin/fields";
import { FormSection } from "@/components/admin/page-header";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { SeoFields } from "@/components/admin/seo-fields";
import { Button } from "@/components/ui/button";
import { facilityGroups } from "@/db/schema/master-data";
import { formatFor } from "@/features/properties/format";
import { formatMoney } from "@/lib/money";
import { richTextToPlain } from "@/lib/rich-text";
import type { SectionProps } from "./types";
import { placeOf } from "@/features/seo/places";
import { mediaVariant } from "@/lib/media-src";
import { listingSeoTitle } from "@/features/seo/titles";

const dateTime = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

const groupLabels: Record<string, string> = {
  building: "Building",
  unit: "In the home",
  community: "Community",
};

/* 7. Description ----------------------------------------------------------- */

export function DescriptionSection({ data, set, errorFor, aiHelpers, propertyId }: SectionProps) {
  // The text an AI draft replaced, so one click brings it back.
  const [before, setBefore] = useState<{ value: PropertyInput["description"] } | null>(null);
  return (
    <FormSection id="description" title="Description">
      {aiHelpers && (
        <div className="flex flex-wrap items-center gap-2">
          <AiButton
            label="Write with AI"
            run={() => aiWriteDescription({ propertyId })}
            onResult={({ text }) => {
              setBefore({ value: data.description });
              set({ description: paragraphsToDoc(text) as PropertyInput["description"] });
            }}
          />
          {/* 07 §3.7: work on the text as it is now; formatting comes back as paragraphs. */}
          {richTextToPlain(data.description).trim().length >= 40 &&
            (["improve", "shorten"] as const).map((edit) => (
              <AiButton
                key={edit}
                label={edit === "improve" ? "Improve" : "Shorten"}
                run={() =>
                  aiEditDescription({
                    propertyId,
                    current: richTextToPlain(data.description),
                    edit,
                  })
                }
                onResult={({ text }) => {
                  setBefore({ value: data.description });
                  set({ description: paragraphsToDoc(text) as PropertyInput["description"] });
                }}
              />
            ))}
          {before && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                set({ description: before.value });
                setBefore(null);
              }}
            >
              Undo AI draft
            </Button>
          )}
          <span className="text-[12.5px] text-text-muted">
            Uses the saved details only; “[add detail]” marks what to fill in.
          </span>
        </div>
      )}
      <RichTextEditor
        label="Description"
        description="Headings, bold, lists and links. 120 words or more helps the listing rank."
        targetWords={120}
        placeholder="What makes this home special: the layout, light, views, building and area."
        value={data.description}
        onChange={(description) => set({ description })}
        error={errorFor("description")}
      />
      <ListField
        label="Highlights"
        description="Short points shown near the top of the page, e.g. “Private pool”."
        placeholder="Add a highlight"
        max={12}
        value={data.highlights}
        onChange={(highlights) => set({ highlights })}
        error={errorFor("highlights")}
      />
    </FormSection>
  );
}

/* 9. Facilities ------------------------------------------------------------ */

export function FacilitiesSection({ data, set, options, errorFor }: SectionProps) {
  const chosen = new Set(data.facilityIds);
  return (
    <FormSection
      id="facilities"
      title="Facilities"
      description={`${chosen.size} selected. Add them in Setup → Facilities.`}
    >
      {options.facilities.length === 0 && (
        <p className="text-[13px] text-text-muted">No facilities set up yet.</p>
      )}
      {facilityGroups.map((group) => {
        const items = options.facilities.filter((f) => f.group === group);
        if (items.length === 0) return null;
        const ids = items.map((f) => f.id);
        return (
          <CheckboxListField
            key={group}
            label={groupLabels[group] ?? group}
            columns={3}
            value={data.facilityIds.filter((id) => ids.includes(id))}
            onChange={(picked) =>
              set({
                facilityIds: [...data.facilityIds.filter((id) => !ids.includes(id)), ...picked],
              })
            }
            options={items.map((f) => ({ value: f.id, label: f.name }))}
          />
        );
      })}
      {errorFor("facilityIds") && (
        <p role="alert" className="text-[12.5px] font-medium text-danger">
          {errorFor("facilityIds")}
        </p>
      )}
    </FormSection>
  );
}

/* 10. Badges --------------------------------------------------------------- */

export function BadgesSection({ data, set, options, activity, errorFor }: SectionProps) {
  const manual = options.badges.filter((b) => b.autoRule === "none");
  const auto = activity.autoBadges
    .map((a) => ({ ...a, badge: options.badges.find((b) => b.id === a.badgeId) }))
    .filter((a) => a.badge);
  return (
    <FormSection
      id="badges"
      title="Badges"
      description="Chips on the listing's photo. Automatic badges follow their rules."
    >
      {manual.length > 0 ? (
        <CheckboxListField
          label="Badges you add"
          columns={3}
          value={data.badgeIds}
          onChange={(badgeIds) => set({ badgeIds })}
          options={manual.map((b) => ({ value: b.id, label: b.name }))}
          error={errorFor("badgeIds")}
        />
      ) : (
        <p className="text-[13px] text-text-muted">No manual badges set up yet.</p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Automatic</h3>
        {auto.length === 0 ? (
          <p className="text-[13px] text-text-muted">None apply right now.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {auto.map((a) => (
              <li key={a.badgeId} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span
                  className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
                  style={{ background: a.badge!.color, color: a.badge!.textColor }}
                >
                  {a.badge!.name}
                </span>
                <span className="text-text-muted">
                  {a.reason}
                  {a.expiresAt ? ` · until ${dateOnly.format(new Date(a.expiresAt))}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormSection>
  );
}

/* 12. Trust ---------------------------------------------------------------- */

export function TrustSection({ data, set, errorFor, market }: SectionProps) {
  return (
    <FormSection
      id="trust"
      title="Trust"
      description="Visitors see when the listing was last checked."
    >
      {market.permit.enabled && (
        <TextInputField
          label={market.permit.label}
          required={market.permit.requiredOnPublish}
          maxLength={60}
          value={data.permitNumber}
          onChange={(permitNumber) => set({ permitNumber })}
          error={errorFor("permitNumber")}
        />
      )}
      <SwitchField
        label="Verified"
        description={
          data.isVerified && data.lastVerifiedAt
            ? `Last verified ${dateOnly.format(new Date(data.lastVerifiedAt))}.`
            : "The details were checked with the owner."
        }
        checked={data.isVerified}
        onChange={(isVerified) =>
          set({
            isVerified,
            lastVerifiedAt: isVerified ? (data.lastVerifiedAt ?? new Date().toISOString()) : null,
          })
        }
      />
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => set({ isVerified: true, lastVerifiedAt: new Date().toISOString() })}
        >
          <BadgeCheckIcon /> Mark verified today
        </Button>
      </div>
    </FormSection>
  );
}

/* 13. SEO ------------------------------------------------------------------ */

export function SeoSection({
  data,
  set,
  errorFor,
  market,
  options,
  media,
  aiHelpers,
}: SectionProps) {
  const plain = richTextToPlain(data.description).replace(/\s+/g, " ");
  const place = placeOf(options.locations, data.locationId);
  const pageTitle = market.titlePattern
    ? listingSeoTitle(market.titlePattern, {
        title: data.title || "Listing",
        beds: data.beds,
        purpose: data.purpose,
        typeName: options.types.find((t) => t.id === data.propertyTypeId)?.name ?? null,
        area: place.area,
        city: place.city,
        price: data.priceOnRequest ? null : data.price,
        currency: data.currency,
        decimals: market.currencies[data.currency]?.decimals ?? 2,
        reference: "",
        agency: market.siteName,
      })
    : data.title || "Listing";
  const photos = data.media.filter((m) => m.kind === "photo");
  const cover = photos.find((m) => m.isCover) ?? photos[0];
  const coverUrl = cover ? media[cover.mediaId]?.url : null;
  return (
    <FormSection id="seo" title="SEO">
      <SeoFields
        values={{
          slug: data.slug,
          seoTitle: data.seoTitle,
          seoDescription: data.seoDescription,
          canonicalUrl: data.canonicalUrl,
          noindex: data.noindex,
          ogImageId: data.ogImageId,
        }}
        onChange={(patch) => set(patch)}
        urlPrefix="/property/"
        fallbackTitle={(market.titleTemplate ?? `%s | ${market.siteName}`).replace("%s", pageTitle)}
        fallbackDescription={plain.slice(0, 155) || undefined}
        siteName={market.siteName}
        errorFor={errorFor}
        shareImageUrl={coverUrl ? mediaVariant(coverUrl, 640) : null}
        aiSuggest={
          aiHelpers
            ? () => aiSuggestSeo({ kind: "listing", title: data.title, text: plain })
            : undefined
        }
        checklist={{
          h1: data.title.trim() !== "",
          imagesWithoutAlt: photos.filter((m) => !m.alt && !media[m.mediaId]?.alt).length,
          words: plain.split(" ").filter(Boolean).length,
          minWords: 100,
        }}
      />
    </FormSection>
  );
}

/* 14. Activity ------------------------------------------------------------- */

const actionLabels: Record<string, string> = {
  "property.create": "Created",
  "property.update": "Edited",
  "property.status": "Status changed",
  "property.verify": "Marked verified",
  "property.feature": "Featured changed",
  "property.agent": "Agent changed",
  "property.archive": "Archived",
  "property.restore": "Restored",
  "property.badge_add": "Badge added",
  "property.badge_remove": "Badge removed",
};

export function ActivitySection({ activity, market }: SectionProps) {
  return (
    <FormSection id="activity" title="Activity">
      <div className="grid gap-3 sm:grid-cols-2">
        <p className="rounded-lg border border-border p-3 text-[13px] text-text-muted">
          <span className="block text-[20px] font-semibold text-ink tabular">
            {activity.views30}
          </span>
          views in the last 30 days
        </p>
        <p className="rounded-lg border border-border p-3 text-[13px] text-text-muted">
          <span className="block text-[20px] font-semibold text-ink tabular">
            {activity.inquiries30}
          </span>
          inquiries in the last 30 days
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Price history</h3>
        {activity.priceHistory.length === 0 ? (
          <p className="text-[13px] text-text-muted">
            Price changes are recorded once the listing has been published.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-start text-[12px] text-text-muted">
              <tr>
                <th scope="col" className="py-1 text-start font-semibold">
                  Date
                </th>
                <th scope="col" className="py-1 text-end font-semibold">
                  From
                </th>
                <th scope="col" className="py-1 text-end font-semibold">
                  To
                </th>
              </tr>
            </thead>
            <tbody>
              {activity.priceHistory.map((h) => {
                const f = formatFor(h.currency, market.currencies);
                return (
                  <tr key={h.changedAt} className="border-t border-border">
                    <td className="py-1.5">{dateTime.format(new Date(h.changedAt))}</td>
                    <td className="py-1.5 text-end tabular">
                      {h.oldPrice == null ? "—" : formatMoney(h.oldPrice, f)}
                    </td>
                    <td className="py-1.5 text-end tabular">
                      {h.newPrice == null ? "—" : formatMoney(h.newPrice, f)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Changes</h3>
        <ol className="flex flex-col gap-1.5 text-[13px]">
          {activity.audit.map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex flex-wrap gap-x-2">
              <span className="text-text-muted tabular">{dateTime.format(new Date(a.at))}</span>
              <span className="font-medium text-ink">{actionLabels[a.action] ?? a.action}</span>
              <span className="text-text-muted">by {a.who}</span>
              {a.fields.length > 0 && a.action === "property.update" && (
                <span className="text-text-muted">({a.fields.join(", ")})</span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </FormSection>
  );
}
