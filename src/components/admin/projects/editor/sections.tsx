"use client";

import Link from "next/link";
import {
  CheckboxListField,
  ListField,
  NumberField,
  SelectField,
  SwitchField,
  TextInputField,
} from "@/components/admin/fields";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { FormSection } from "@/components/admin/page-header";
import { PaymentPlanBuilder } from "@/components/admin/payment-plans/plan-builder";
import { LocationSelect } from "@/components/admin/properties/editor/location-select";
import { MediaList, Uploads, withKind } from "@/components/admin/properties/editor/media-section";
import { DateField, Segmented } from "@/components/admin/properties/editor/sections-a";
import { StatusPill } from "@/components/admin/properties/status-pill";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { SeoFields } from "@/components/admin/seo-fields";
import { aiSuggestSeo } from "@/features/ai/helper-actions";
import { PinPicker } from "@/components/maps/pin-picker";
import { AdminField } from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import { facilityGroups } from "@/db/schema/master-data";
import { projectStatuses } from "@/db/schema/projects";
import { geocodeAddress } from "@/features/locations/actions";
import type { MediaItem } from "@/features/media/queries";
import { emptyPlan } from "@/features/payment-plans/schema";
import { formatFor } from "@/features/properties/format";
import {
  lowestUnitPrice,
  projectStatusLabels,
  suggestUnitSummary,
} from "@/features/projects/schema";
import { formatMoney, toMajor, toMinor } from "@/lib/money";
import { richTextToPlain } from "@/lib/rich-text";
import type { ProjectSectionProps } from "./types";
import { placeOf } from "@/features/seo/places";
import { mediaVariant } from "@/lib/media-src";
import { projectSeoTitle } from "@/features/seo/titles";

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
  unit: "In the homes",
  community: "Community",
};

/** Money stored in minor units, typed in major units. */
export function MoneyInput({
  label,
  value,
  onChange,
  decimals,
  suffix,
  error,
  description,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  decimals: number;
  suffix: string;
  error?: string;
  description?: string;
}) {
  return (
    <NumberField
      label={label}
      description={description}
      min={0}
      step={decimals ? 1 / 10 ** decimals : 1}
      suffix={suffix}
      value={value == null ? null : toMajor(value, decimals)}
      onChange={(v) => onChange(v == null ? null : toMinor(v, decimals))}
      error={error}
    />
  );
}

/* Basics ------------------------------------------------------------------- */

export function BasicsSection({ data, set, errorFor, options, market }: ProjectSectionProps) {
  return (
    <FormSection id="basics" title="Basics">
      <TextInputField
        label="Project name"
        required
        maxLength={120}
        value={data.name}
        onChange={(name) => set({ name })}
        error={errorFor("name")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Developer"
          required
          value={data.developerId}
          onChange={(developerId) => set({ developerId })}
          options={options.developers.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="Choose a developer"
          error={errorFor("developerId")}
        />
        <SelectField
          label="Project status"
          value={data.status}
          onChange={(status) => set({ status })}
          options={projectStatuses.map((s) => ({ value: s, label: projectStatusLabels[s] }))}
          error={errorFor("status")}
        />
      </div>
      <LocationSelect
        label="Location"
        required
        nodes={options.locations}
        value={data.locationId}
        onChange={(locationId) => set({ locationId })}
        error={errorFor("locationId")}
      />
      <AdminField
        label="Map pin"
        required
        description="Drag the pin, search an address or paste coordinates."
        error={errorFor("point")}
      >
        <PinPicker
          value={data.point}
          onChange={(point) => set({ point })}
          styleUrl={market.styleUrl}
          fallbackCenter={data.point ?? market.mapCenter}
          zoom={data.point ? 15 : market.mapZoom}
          onSearch={async (query) => {
            const res = await geocodeAddress(query);
            return res.ok ? res.data : { error: res.error };
          }}
        />
      </AdminField>
      <SwitchField
        label="Featured"
        description="Shown first among projects on the site."
        checked={data.isFeatured}
        onChange={(isFeatured) => set({ isFeatured })}
      />
    </FormSection>
  );
}

/* Dates and progress ------------------------------------------------------- */

export function DatesSection({
  data,
  set,
  errorFor,
  progressUpdatedAt,
  progressChanged,
}: ProjectSectionProps & { progressUpdatedAt: string | null; progressChanged: boolean }) {
  return (
    <FormSection id="dates" title="Dates and progress">
      <div className="grid gap-4 sm:grid-cols-3">
        <DateField
          label="Launch date"
          value={data.launchDate}
          onChange={(launchDate) => set({ launchDate })}
          error={errorFor("launchDate")}
        />
        <DateField
          label="Handover date"
          value={data.handoverDate}
          onChange={(handoverDate) => set({ handoverDate })}
          error={errorFor("handoverDate")}
        />
        <TextInputField
          label="Or handover quarter"
          placeholder="e.g. Q4 2027"
          maxLength={40}
          value={data.handoverText}
          onChange={(handoverText) => set({ handoverText })}
          error={errorFor("handoverText")}
        />
      </div>
      <NumberField
        label="Construction progress"
        suffix="%"
        min={0}
        max={100}
        step={1}
        description={
          progressChanged
            ? "Saved with today's date."
            : progressUpdatedAt
              ? `Updated on ${dateOnly.format(new Date(progressUpdatedAt))}.`
              : "Shown on the project and its listings."
        }
        value={data.constructionProgress}
        onChange={(constructionProgress) => set({ constructionProgress })}
        error={errorFor("constructionProgress")}
      />
    </FormSection>
  );
}

/* Pricing ------------------------------------------------------------------ */

export function PricingSection({ data, set, errorFor, market }: ProjectSectionProps) {
  const currency = formatFor(data.currency, market.currencies);
  const lowest = lowestUnitPrice(data.unitTypes);
  const summary = suggestUnitSummary(data.unitTypes);
  return (
    <FormSection id="pricing" title="Pricing">
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <MoneyInput
          label="Starting price"
          value={data.startingPrice}
          onChange={(startingPrice) => set({ startingPrice })}
          decimals={currency.decimals}
          suffix={currency.code}
          error={errorFor("startingPrice")}
          description={
            lowest != null && lowest !== data.startingPrice
              ? `The lowest unit type starts at ${formatMoney(lowest, currency)}.`
              : undefined
          }
        />
        <SelectField
          label="Currency"
          value={data.currency}
          onChange={(code) => set({ currency: code })}
          options={Object.values(market.currencies).map((c) => ({ value: c.code, label: c.code }))}
          error={errorFor("currency")}
        />
      </div>
      {lowest != null && lowest !== data.startingPrice && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set({ startingPrice: lowest })}
          >
            Use the lowest unit price
          </Button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Total units"
          min={0}
          step={1}
          value={data.totalUnits}
          onChange={(totalUnits) => set({ totalUnits })}
          error={errorFor("totalUnits")}
        />
        <TextInputField
          label="Unit types in short"
          maxLength={200}
          placeholder={summary ? `e.g. ${summary} apartments` : "e.g. 1 to 3 bed apartments"}
          value={data.unitTypesSummary}
          onChange={(unitTypesSummary) => set({ unitTypesSummary })}
          error={errorFor("unitTypesSummary")}
        />
      </div>
    </FormSection>
  );
}

/* Description -------------------------------------------------------------- */

export function DescriptionSection({ data, set, errorFor }: ProjectSectionProps) {
  return (
    <FormSection id="description" title="Description">
      <RichTextEditor
        label="Description"
        description="Headings, bold, lists and links."
        placeholder="The setting, the architecture, the amenities and what is nearby."
        value={data.description}
        onChange={(description) => set({ description })}
        error={errorFor("description")}
      />
      <ListField
        label="Highlights"
        description="Short points shown near the top of the page, e.g. “Beach access”."
        placeholder="Add a highlight"
        max={12}
        value={data.highlights}
        onChange={(highlights) => set({ highlights })}
        error={errorFor("highlights")}
      />
    </FormSection>
  );
}

/* Media -------------------------------------------------------------------- */

export function ProjectMediaSection({
  data,
  set,
  errorFor,
  media,
  rememberMedia,
  readOnly,
}: ProjectSectionProps) {
  const photos = data.media.filter((m) => m.kind === "photo");
  const addPhotos = (items: MediaItem[]) => {
    rememberMedia(items);
    const fresh = items
      .filter((i) => !photos.some((m) => m.mediaId === i.id))
      .map((i, n) => ({
        mediaId: i.id,
        kind: "photo" as const,
        isCover: photos.length === 0 && n === 0,
        caption: "",
        alt: "",
      }));
    if (fresh.length) set({ media: withKind(data.media, "photo", [...photos, ...fresh]) });
  };
  return (
    <FormSection
      id="media"
      title="Media"
      description={`${photos.length} ${photos.length === 1 ? "photo" : "photos"}. Drag to reorder; the star marks the cover.`}
    >
      {errorFor("media") && (
        <p role="alert" className="text-[12.5px] font-medium text-danger">
          {errorFor("media")}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Gallery</h3>
        <Uploads
          kind="photo"
          label="Photos"
          folder="projects"
          onAdd={addPhotos}
          readOnly={readOnly}
        />
        <MediaList
          kind="photo"
          label="Photos"
          items={photos}
          media={media}
          readOnly={readOnly}
          onChange={(items) => set({ media: withKind(data.media, "photo", items) })}
        />
        {!readOnly && (
          <MediaPicker
            label="Add a photo from the library"
            value={null}
            onChange={(_id, item) => item && addPhotos([item])}
          />
        )}
      </div>
      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <MediaPicker
          label="Master plan"
          description="The site plan of the whole development."
          value={data.masterPlanId}
          disabled={readOnly}
          onChange={(masterPlanId, item) => {
            if (item) rememberMedia([item]);
            set({ masterPlanId });
          }}
          error={errorFor("masterPlanId")}
        />
        <MediaPicker
          label="Brochure"
          description="A PDF visitors can download (the developer's own, for example). A branded brochure is generated from the project when you leave this empty."
          type="document"
          value={data.brochureId}
          disabled={readOnly}
          onChange={(brochureId, item) => {
            if (item) rememberMedia([item]);
            set({ brochureId });
          }}
          error={errorFor("brochureId")}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInputField
          label="Video link"
          type="url"
          placeholder="https://"
          value={data.videoUrl ?? ""}
          onChange={(v) => set({ videoUrl: v || null })}
          error={errorFor("videoUrl")}
        />
        <TextInputField
          label="360° tour link"
          type="url"
          placeholder="https://"
          value={data.tourUrl ?? ""}
          onChange={(v) => set({ tourUrl: v || null })}
          error={errorFor("tourUrl")}
        />
      </div>
    </FormSection>
  );
}

/* Facilities --------------------------------------------------------------- */

export function FacilitiesSection({ data, set, options, errorFor }: ProjectSectionProps) {
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

/* Payment plan ------------------------------------------------------------- */

export function PlanSection({ data, set, errorFor, options, market }: ProjectSectionProps) {
  const currency = formatFor(data.currency, market.currencies);
  const planErrorFor = (path: string) =>
    path === "steps"
      ? (errorFor("paymentPlan.steps") ?? errorFor("paymentPlan"))
      : errorFor(`paymentPlan.${path}`);
  return (
    <FormSection
      id="plan"
      title="Payment plan"
      description="Listings in this project show this plan unless they have their own."
    >
      <Segmented
        label="Payment plan"
        value={data.paymentPlan ? "own" : "none"}
        onChange={(mode) =>
          set({ paymentPlan: mode === "own" ? (data.paymentPlan ?? emptyPlan()) : null })
        }
        options={[
          { value: "none", label: "No plan" },
          { value: "own", label: "The project's plan" },
        ]}
      />
      {data.paymentPlan && (
        <PaymentPlanBuilder
          value={data.paymentPlan}
          onChange={(paymentPlan) => set({ paymentPlan })}
          templates={options.planTemplates}
          currency={currency}
          price={data.startingPrice}
          errorFor={planErrorFor}
        />
      )}
    </FormSection>
  );
}

/* SEO ---------------------------------------------------------------------- */

export function SeoSection({
  data,
  set,
  errorFor,
  market,
  options,
  media,
  aiHelpers,
}: ProjectSectionProps) {
  const plain = richTextToPlain(data.description).replace(/\s+/g, " ");
  const pageTitle = market.titlePattern
    ? projectSeoTitle(market.titlePattern, {
        name: data.name || "Project",
        developer: options.developers.find((d) => d.id === data.developerId)?.name ?? null,
        area: placeOf(options.locations, data.locationId).area,
        agency: market.siteName,
      })
    : data.name || "Project";
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
        urlPrefix="/projects/"
        fallbackTitle={(market.titleTemplate ?? `%s | ${market.siteName}`).replace("%s", pageTitle)}
        fallbackDescription={plain.slice(0, 155) || undefined}
        siteName={market.siteName}
        errorFor={errorFor}
        shareImageUrl={coverUrl ? mediaVariant(coverUrl, 640) : null}
        aiSuggest={
          aiHelpers
            ? () =>
                aiSuggestSeo({
                  kind: "off-plan project",
                  title: pageTitle,
                  text: plain.slice(0, 20_000),
                })
            : undefined
        }
        checklist={{
          h1: data.name.trim() !== "",
          imagesWithoutAlt: photos.filter((m) => !m.alt && !media[m.mediaId]?.alt).length,
          words: plain.split(" ").filter(Boolean).length,
          minWords: 100,
        }}
      />
    </FormSection>
  );
}

/* Listings ----------------------------------------------------------------- */

export function ListingsSection({
  data,
  activity,
  readOnly,
  onCreate,
}: ProjectSectionProps & { onCreate: () => void }) {
  const unitName = (id: string | null) => data.unitTypes.find((u) => u.id === id)?.name;
  return (
    <FormSection
      id="listings"
      title="Listings"
      description="Listings linked to this project."
      actions={
        !readOnly &&
        data.unitTypes.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={onCreate}>
            Create listings from unit types
          </Button>
        )
      }
    >
      {activity.listings.length === 0 ? (
        <p className="text-[13px] text-text-muted">
          No listings yet. Add unit types, then create draft listings from them.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {activity.listings.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]"
            >
              <span className="min-w-0">
                <Link
                  href={`/admin/properties/${l.id}`}
                  className="font-medium text-ink hover:underline"
                >
                  {l.title || "Untitled listing"}
                </Link>
                <span className="ms-2 text-text-muted tabular">{l.reference}</span>
                {unitName(l.unitTypeId) && (
                  <span className="ms-2 text-text-muted">· {unitName(l.unitTypeId)}</span>
                )}
              </span>
              <StatusPill status={l.status} />
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}

/* Activity ----------------------------------------------------------------- */

const actionLabels: Record<string, string> = {
  "project.create": "Created",
  "project.update": "Edited",
  "project.publish": "Published",
  "project.unpublish": "Unpublished",
};

export function ActivitySection({ activity }: ProjectSectionProps) {
  return (
    <FormSection id="activity" title="Activity">
      <ol className="flex flex-col gap-1.5 text-[13px]">
        {activity.audit.map((a, i) => (
          <li key={`${a.at}-${i}`} className="flex flex-wrap gap-x-2">
            <span className="text-text-muted tabular">{dateTime.format(new Date(a.at))}</span>
            <span className="font-medium text-ink">{actionLabels[a.action] ?? a.action}</span>
            <span className="text-text-muted">by {a.who}</span>
            {a.fields.length > 0 && a.action === "project.update" && (
              <span className="text-text-muted">({a.fields.join(", ")})</span>
            )}
          </li>
        ))}
      </ol>
    </FormSection>
  );
}
