"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  CheckboxListField,
  ListField,
  NumberField,
  SelectField,
  SwitchField,
  TextInputField,
  TextareaField,
} from "@/components/admin/fields";
import { IconField } from "@/components/admin/icon-picker";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { LocationSelect } from "@/components/admin/properties/editor/location-select";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { faqGroups } from "@/db/schema/content";
import type { SectionOptions } from "@/features/cms/page-admin";
import {
  pageFormTypes,
  siteTools,
  type SectionPropsOf,
  type SectionType,
  type SiteTool,
} from "@/features/cms/sections";
import type { MediaItem } from "@/features/media/queries";
import { emptyDoc, type RichDoc } from "@/lib/rich-text";
import {
  ButtonsField,
  ChoiceField,
  GalleryField,
  ItemsField,
  ListingPicker,
  OptionPicker,
  type Btn,
} from "./field-kit";

/** What every section form gets: its props, a setter, errors and the editor's lookups. */
export type FormContext = {
  options: SectionOptions;
  media: Record<string, MediaItem>;
  rememberMedia: (item: MediaItem) => void;
  allowScripts: boolean;
};

type FormProps<T extends SectionType> = {
  p: Partial<SectionPropsOf<T>>;
  set: (patch: Partial<SectionPropsOf<T>>) => void;
  /** Error for a props field: err("heading") reads "props.heading". */
  err: (field: string) => string | undefined;
  ctx: FormContext;
};

export const faqGroupLabels: Record<(typeof faqGroups)[number], string> = {
  buying: "Buying",
  renting: "Renting",
  off_plan: "Off-plan",
  selling: "Selling",
  general: "General",
};

export const toolLabels: Record<SiteTool, string> = {
  mortgage: "Mortgage calculator",
  rental_returns: "Rental returns",
  compare: "Compare homes",
  valuation: "Free valuation",
  list_property: "List your property",
};

export const formTypeLabels: Record<(typeof pageFormTypes)[number], string> = {
  contact: "Contact",
  callback: "Callback request",
  valuation: "Valuation request",
  list_property: "List your property",
  newsletter: "Newsletter signup",
};

type HeadingProps = { eyebrow?: string; heading?: string };

/** Eyebrow and heading, which most sections share. */
function Eyebrow({
  p,
  set,
  err,
}: {
  p: HeadingProps;
  set: (patch: HeadingProps) => void;
  err: (field: string) => string | undefined;
}) {
  return (
    <>
      <TextInputField
        label="Eyebrow"
        description="A short line above the heading (optional)."
        value={p.eyebrow ?? ""}
        maxLength={60}
        onChange={(eyebrow) => set({ eyebrow })}
        error={err("eyebrow")}
      />
      <TextInputField
        label="Heading"
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
    </>
  );
}

function Count({
  value,
  onChange,
  min,
  max,
  label = "How many",
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label?: string;
}) {
  return (
    <NumberField
      label={label}
      description={`${min} to ${max}.`}
      value={value ?? min}
      min={min}
      max={max}
      step={1}
      onChange={(v) => onChange(Math.min(max, Math.max(min, Math.round(v ?? min))))}
    />
  );
}

function ViewAll({
  value,
  onChange,
  err,
}: {
  value: Btn | null | undefined;
  onChange: (v: Btn | null) => void;
  err: (field: string) => string | undefined;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <SwitchField
        label="“View all” link"
        checked={Boolean(value)}
        onChange={(on) => onChange(on ? { label: "", href: "" } : null)}
      />
      {value && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField
            label="Label"
            value={value.label}
            placeholder="View all"
            maxLength={40}
            onChange={(label) => onChange({ ...value, label })}
            error={err("viewAll.label")}
          />
          <TextInputField
            label="Link"
            value={value.href}
            placeholder="/buy"
            onChange={(href) => onChange({ ...value, href })}
            error={err("viewAll.href")}
          />
        </div>
      )}
    </div>
  );
}

const setupLink = (href: string, label: string) => (
  <>
    Add them in{" "}
    <Link href={href} className="text-ink underline">
      {label}
    </Link>
    .
  </>
);

const forms: { [T in SectionType]: (props: FormProps<T>) => ReactNode } = {
  hero_search: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Eyebrow"
        value={p.eyebrow ?? ""}
        maxLength={60}
        onChange={(eyebrow) => set({ eyebrow })}
        error={err("eyebrow")}
      />
      <TextInputField
        label="Heading"
        required
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <TextareaField
        label="Subheading"
        rows={2}
        value={p.subheading ?? ""}
        maxLength={240}
        onChange={(subheading) => set({ subheading })}
        error={err("subheading")}
      />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[13px] font-semibold text-ink">Search tabs</legend>
        {(["buy", "rent", "off_plan"] as const).map((tab) => {
          const tabs = p.tabs ?? ["buy", "rent", "off_plan"];
          return (
            <label key={tab} className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)]"
                checked={tabs.includes(tab)}
                disabled={tabs.length === 1 && tabs.includes(tab)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? (["buy", "rent", "off_plan"] as const).filter(
                        (t) => tabs.includes(t) || t === tab,
                      )
                    : tabs.filter((t) => t !== tab);
                  set({
                    tabs: next,
                    defaultTab: next.includes(p.defaultTab ?? "buy") ? p.defaultTab : next[0],
                  });
                }}
              />
              {{ buy: "Buy", rent: "Rent", off_plan: "Off-plan" }[tab]}
            </label>
          );
        })}
      </fieldset>
      <SelectField
        label="Tab shown first"
        value={p.defaultTab ?? "buy"}
        onChange={(defaultTab) => set({ defaultTab })}
        options={(p.tabs ?? ["buy", "rent", "off_plan"]).map((t) => ({
          value: t,
          label: { buy: "Buy", rent: "Rent", off_plan: "Off-plan" }[t],
        }))}
      />
      <MediaPicker
        label="Image"
        value={p.imageId ?? null}
        onChange={(imageId) => set({ imageId })}
        error={err("imageId")}
      />
      <SwitchField
        label="Floating badge on the image"
        checked={p.floatingBadge ?? false}
        onChange={(floatingBadge) => set({ floatingBadge })}
      />
      {p.floatingBadge && (
        <TextInputField
          label="Badge text"
          placeholder="e.g. Every home verified in person"
          value={p.floatingBadgeText ?? ""}
          maxLength={60}
          onChange={(floatingBadgeText) => set({ floatingBadgeText })}
          error={err("floatingBadgeText")}
        />
      )}
    </>
  ),
  hero_simple: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Heading"
        required
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <TextareaField
        label="Subheading"
        rows={2}
        value={p.subheading ?? ""}
        maxLength={240}
        onChange={(subheading) => set({ subheading })}
        error={err("subheading")}
      />
      <MediaPicker
        label="Background image (optional)"
        value={p.imageId ?? null}
        onChange={(imageId) => set({ imageId })}
        error={err("imageId")}
      />
      <ButtonsField
        value={p.buttons}
        onChange={(buttons) => set({ buttons })}
        path="props.buttons"
        errorFor={(f) => err(f.replace(/^props\./, ""))}
      />
    </>
  ),
  promise_strip: ({ p, set, err }) => (
    <ItemsField
      label="Points"
      noun="point"
      min={2}
      max={4}
      value={p.items}
      onChange={(items) => set({ items })}
      blank={() => ({ title: "", text: "", icon: "" })}
      render={(item, setItem, i) => (
        <>
          <TextInputField
            label="Title"
            value={item.title}
            maxLength={60}
            onChange={(title) => setItem({ title })}
            error={err(`items.${i}.title`)}
          />
          <TextareaField
            label="Text"
            rows={2}
            value={item.text}
            maxLength={200}
            onChange={(text) => setItem({ text })}
            error={err(`items.${i}.text`)}
          />
          <IconField
            label="Icon"
            value={item.icon || null}
            onChange={(icon) => setItem({ icon: icon ?? "" })}
          />
        </>
      )}
    />
  ),
  featured_listings: (props) => {
    const { p, set, err } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which listings"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "featured", label: "Featured" },
            { value: "newest", label: "Newest" },
            { value: "manual", label: "Pick by hand" },
            { value: "filter", label: "By filter" },
          ]}
        />
        {p.source === "manual" && (
          <ListingPicker
            label="Listings"
            value={p.listingIds}
            onChange={(listingIds) => set({ listingIds })}
            max={12}
            error={err("listingIds")}
          />
        )}
        {p.source === "filter" && (
          <TextInputField
            label="Filter"
            description="Search the site, then paste the part after “?” from the address, e.g. type=villas&max=5000000."
            value={p.filter ?? ""}
            onChange={(filter) => set({ filter: filter.replace(/^[^?]*\?/, "") })}
            error={err("filter")}
          />
        )}
        {p.source !== "manual" && (
          <Count value={p.count} onChange={(count) => set({ count })} min={3} max={12} />
        )}
        <ChoiceField
          label="Layout"
          value={p.layout}
          onChange={(layout) => set({ layout })}
          options={[
            { value: "grid", label: "Grid" },
            { value: "carousel", label: "Carousel" },
          ]}
        />
        <ViewAll value={p.viewAll} onChange={(viewAll) => set({ viewAll })} err={err} />
      </>
    );
  },
  projects_showcase: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which projects"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "featured", label: "Featured" },
            { value: "manual", label: "Pick by hand" },
            { value: "area", label: "In an area" },
          ]}
        />
        {p.source === "manual" && (
          <OptionPicker
            label="Projects"
            value={p.projectIds}
            onChange={(projectIds) => set({ projectIds })}
            options={ctx.options.projects}
            max={8}
            error={err("projectIds")}
            empty={setupLink("/admin/projects", "Projects")}
          />
        )}
        {p.source === "area" && (
          <LocationSelect
            label="Area"
            nodes={ctx.options.locations}
            value={p.locationId ?? null}
            onChange={(locationId) => set({ locationId })}
            error={err("locationId")}
          />
        )}
        {p.source !== "manual" && (
          <Count value={p.count} onChange={(count) => set({ count })} min={1} max={8} />
        )}
        <SwitchField
          label="Dark band"
          checked={p.dark ?? true}
          onChange={(dark) => set({ dark })}
        />
        <ViewAll value={p.viewAll} onChange={(viewAll) => set({ viewAll })} err={err} />
      </>
    );
  },
  areas_grid: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which areas"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "featured", label: "Featured areas" },
            { value: "manual", label: "Pick by hand" },
          ]}
        />
        {p.source === "manual" ? (
          <OptionPicker
            label="Areas"
            value={p.locationIds}
            onChange={(locationIds) => set({ locationIds })}
            options={ctx.options.locations
              .filter((l) => l.level !== "building")
              .map((l) => ({ id: l.id, name: l.name, detail: l.level }))}
            max={12}
            error={err("locationIds")}
          />
        ) : (
          <Count value={p.count} onChange={(count) => set({ count })} min={2} max={12} />
        )}
      </>
    );
  },
  search_embed: (props) => {
    const { p, set, err } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <TextInputField
          label="Search"
          required
          description="Search the site with the filters you want, then paste the address here, e.g. /buy/marina/villas?max=5000000."
          value={p.search ?? ""}
          onChange={(search) => set({ search: search.trim() })}
          error={err("search")}
        />
        <Count value={p.count} onChange={(count) => set({ count })} min={3} max={12} />
        <ChoiceField
          label="Layout"
          value={p.layout}
          onChange={(layout) => set({ layout })}
          options={[
            { value: "grid", label: "Grid" },
            { value: "carousel", label: "Carousel" },
          ]}
        />
        <SwitchField
          label="Link to all results"
          checked={p.showViewAll ?? true}
          onChange={(showViewAll) => set({ showViewAll })}
        />
        {p.showViewAll !== false && (
          <TextInputField
            label="Link label"
            placeholder="View all"
            value={p.viewAllLabel ?? ""}
            maxLength={40}
            onChange={(viewAllLabel) => set({ viewAllLabel })}
            error={err("viewAllLabel")}
          />
        )}
      </>
    );
  },
  text: ({ p, set, err }) => (
    <>
      <RichTextEditor
        label="Text"
        value={(p.body as RichDoc | undefined) ?? emptyDoc()}
        onChange={(body) => set({ body })}
        error={err("body")}
      />
      <ChoiceField
        label="Width"
        value={p.maxWidth}
        onChange={(maxWidth) => set({ maxWidth })}
        options={[
          { value: "narrow", label: "Narrow (easy reading)" },
          { value: "normal", label: "Wide" },
        ]}
      />
    </>
  ),
  text_image: (props) => {
    const { p, set, err } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <RichTextEditor
          label="Text"
          value={(p.body as RichDoc | undefined) ?? emptyDoc()}
          onChange={(body) => set({ body })}
          error={err("body")}
        />
        <MediaPicker
          label="Image"
          value={p.imageId ?? null}
          onChange={(imageId) => set({ imageId })}
          error={err("imageId")}
        />
        <ChoiceField
          label="Image side"
          value={p.imageSide}
          onChange={(imageSide) => set({ imageSide })}
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
          ]}
        />
        <ChoiceField
          label="Image shape"
          value={p.imageShape}
          onChange={(imageShape) => set({ imageShape })}
          options={[
            { value: "portrait", label: "Portrait" },
            { value: "square", label: "Square" },
            { value: "landscape", label: "Landscape" },
          ]}
        />
        <ButtonsField
          value={p.buttons}
          onChange={(buttons) => set({ buttons })}
          path="props.buttons"
          errorFor={(f) => err(f.replace(/^props\./, ""))}
        />
      </>
    );
  },
  stats: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Heading"
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <ItemsField
        label="Numbers"
        noun="number"
        min={1}
        max={6}
        value={p.items}
        onChange={(items) => set({ items })}
        blank={() => ({ value: "", label: "", source: "" })}
        render={(item, setItem, i) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInputField
                label="Number"
                placeholder="e.g. 1,200+"
                value={item.value}
                maxLength={20}
                onChange={(value) => setItem({ value })}
                error={err(`items.${i}.value`)}
              />
              <TextInputField
                label="Label"
                placeholder="e.g. homes sold"
                value={item.label}
                maxLength={60}
                onChange={(label) => setItem({ label })}
                error={err(`items.${i}.label`)}
              />
            </div>
            <TextInputField
              label="Where the number comes from"
              description="Shown in small print. Only numbers you can back up."
              placeholder="e.g. Our sales records, 2015-2026"
              value={item.source}
              maxLength={120}
              onChange={(source) => setItem({ source })}
              error={err(`items.${i}.source`)}
            />
          </>
        )}
      />
    </>
  ),
  testimonials: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which testimonials"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "latest", label: "The latest published" },
            { value: "manual", label: "Pick by hand" },
          ]}
        />
        {p.source === "manual" ? (
          <OptionPicker
            label="Testimonials"
            value={p.testimonialIds}
            onChange={(testimonialIds) => set({ testimonialIds })}
            options={ctx.options.testimonials}
            max={12}
            error={err("testimonialIds")}
            empty={setupLink("/admin/website/testimonials", "Website → Testimonials")}
          />
        ) : (
          <Count value={p.count} onChange={(count) => set({ count })} min={1} max={12} />
        )}
        <ChoiceField
          label="Layout"
          value={p.layout}
          onChange={(layout) => set({ layout })}
          options={[
            { value: "grid", label: "Grid" },
            { value: "carousel", label: "Carousel" },
            { value: "quote", label: "One big quote" },
          ]}
        />
      </>
    );
  },
  faq: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which questions"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "group", label: "A group" },
            { value: "manual", label: "Pick by hand" },
          ]}
        />
        {p.source === "manual" ? (
          <OptionPicker
            label="Questions"
            value={p.faqIds}
            onChange={(faqIds) => set({ faqIds })}
            options={ctx.options.faqs.map((f) => ({
              ...f,
              detail: [faqGroupLabels[f.group as keyof typeof faqGroupLabels], f.detail]
                .filter(Boolean)
                .join(" · "),
            }))}
            max={30}
            error={err("faqIds")}
            empty={setupLink("/admin/website/faqs", "Website → FAQs")}
          />
        ) : (
          <>
            <SelectField
              label="Group"
              value={p.group ?? "general"}
              onChange={(group) => set({ group })}
              options={faqGroups.map((g) => ({ value: g, label: faqGroupLabels[g] }))}
            />
            <Count value={p.count} onChange={(count) => set({ count })} min={1} max={30} />
          </>
        )}
        <SwitchField
          label="FAQ structured data"
          description="Helps search engines show the questions. Only the first FAQ section of a page adds it."
          checked={p.schema ?? true}
          onChange={(schema) => set({ schema })}
        />
      </>
    );
  },
  team: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Who"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "all", label: "Everyone shown on the site" },
            { value: "manual", label: "Pick by hand" },
          ]}
        />
        {p.source === "manual" ? (
          <OptionPicker
            label="Agent profiles"
            value={p.agentIds}
            onChange={(agentIds) => set({ agentIds })}
            options={ctx.options.agents}
            max={24}
            error={err("agentIds")}
            empty={setupLink("/admin/setup/agents", "Setup → Agents")}
          />
        ) : (
          <Count value={p.count} onChange={(count) => set({ count })} min={1} max={24} />
        )}
        <ViewAll value={p.viewAll} onChange={(viewAll) => set({ viewAll })} err={err} />
      </>
    );
  },
  developer_logos: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which developers"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "all", label: "All with a logo" },
            { value: "manual", label: "Pick by hand" },
          ]}
        />
        {p.source === "manual" ? (
          <OptionPicker
            label="Developers"
            value={p.developerIds}
            onChange={(developerIds) => set({ developerIds })}
            options={ctx.options.developers}
            max={24}
            error={err("developerIds")}
            empty={setupLink("/admin/setup/developers", "Setup → Developers")}
          />
        ) : (
          <Count value={p.count} onChange={(count) => set({ count })} min={1} max={24} />
        )}
      </>
    );
  },
  blog_posts: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <ChoiceField
          label="Which posts"
          value={p.source}
          onChange={(source) => set({ source })}
          options={[
            { value: "latest", label: "The latest" },
            { value: "category", label: "The latest in a category" },
          ]}
        />
        {p.source === "category" && (
          <SelectField
            label="Category"
            value={p.categoryId ?? ""}
            onChange={(categoryId) => set({ categoryId })}
            options={ctx.options.postCategories.map((c) => ({ value: c.id, label: c.name }))}
            placeholder={
              ctx.options.postCategories.length ? "Choose a category" : "No categories yet"
            }
            disabled={ctx.options.postCategories.length === 0}
            error={err("categoryId")}
          />
        )}
        <Count value={p.count} onChange={(count) => set({ count })} min={1} max={12} />
        <ViewAll value={p.viewAll} onChange={(viewAll) => set({ viewAll })} err={err} />
      </>
    );
  },
  cta: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Heading"
        required
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <TextareaField
        label="Text"
        rows={3}
        value={p.text ?? ""}
        maxLength={300}
        onChange={(text) => set({ text })}
        error={err("text")}
      />
      <ButtonsField
        value={p.buttons}
        onChange={(buttons) => set({ buttons })}
        path="props.buttons"
        errorFor={(f) => err(f.replace(/^props\./, ""))}
      />
      <p className="text-[12.5px] text-text-muted">The background is set in the Style tab.</p>
    </>
  ),
  tools: ({ p, set, err }) => (
    <>
      <Eyebrow p={p} set={set} err={err} />
      <CheckboxListField
        label="Tools to show"
        value={p.tools ?? []}
        onChange={(tools) => set({ tools })}
        options={siteTools.map((value) => ({ value, label: toolLabels[value] }))}
        error={err("tools")}
      />
    </>
  ),
  ai_teaser: ({ p, set, err }) => (
    <>
      <Eyebrow p={p} set={set} err={err} />
      <TextareaField
        label="Text"
        rows={3}
        value={p.text ?? ""}
        maxLength={300}
        onChange={(text) => set({ text })}
        error={err("text")}
      />
      <ListField
        label="Example questions"
        description="Each one opens the chat with the question typed in. Up to 6."
        value={p.prompts ?? []}
        max={6}
        placeholder="e.g. Two-bed apartments near the beach?"
        onChange={(prompts) => set({ prompts })}
        error={err("prompts")}
      />
      <p className="text-[12.5px] text-text-muted">
        The section shows only while the website chat is on (Settings &rarr; AI).
      </p>
    </>
  ),
  contact_block: (props) => {
    const { p, set, err } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <TextareaField
          label="Text"
          rows={3}
          value={p.text ?? ""}
          maxLength={400}
          onChange={(text) => set({ text })}
          error={err("text")}
        />
        <SwitchField
          label="Office details"
          description="Phone, WhatsApp, email, address and opening hours from Settings → Contact."
          checked={p.showDetails ?? true}
          onChange={(showDetails) => set({ showDetails })}
        />
        <SwitchField
          label="Map of the office"
          description="Uses the office pin from Settings → Contact."
          checked={p.showMap ?? true}
          onChange={(showMap) => set({ showMap })}
        />
        <SwitchField
          label="Contact form"
          checked={p.showForm ?? true}
          onChange={(showForm) => set({ showForm })}
        />
        {p.showForm !== false && (
          <TextInputField
            label="Form heading"
            placeholder="Send us a message"
            value={p.formHeading ?? ""}
            maxLength={120}
            onChange={(formHeading) => set({ formHeading })}
            error={err("formHeading")}
          />
        )}
      </>
    );
  },
  form: (props) => {
    const { p, set, err } = props;
    return (
      <>
        <SelectField
          label="Form"
          value={p.formType ?? "contact"}
          onChange={(formType) => set({ formType })}
          options={pageFormTypes.map((t) => ({ value: t, label: formTypeLabels[t] }))}
        />
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <TextareaField
          label="Text"
          rows={2}
          value={p.text ?? ""}
          maxLength={400}
          onChange={(text) => set({ text })}
          error={err("text")}
        />
        <TextInputField
          label="Button label"
          placeholder="Send"
          value={p.buttonLabel ?? ""}
          maxLength={40}
          onChange={(buttonLabel) => set({ buttonLabel })}
          error={err("buttonLabel")}
        />
        <TextareaField
          label="After sending"
          description="What the visitor reads once it is sent: say what happens next."
          placeholder="Thank you. We'll reply within one working day."
          rows={2}
          value={p.successMessage ?? ""}
          maxLength={300}
          onChange={(successMessage) => set({ successMessage })}
          error={err("successMessage")}
        />
      </>
    );
  },
  video: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Heading"
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <TextInputField
        label="Video link"
        required
        type="url"
        description="A YouTube or Vimeo link, or an https link to an .mp4 file."
        value={p.url ?? ""}
        onChange={(url) => set({ url: url.trim() })}
        error={err("url")}
      />
      <MediaPicker
        label="Poster image"
        description="Shown before the video plays. YouTube's own still is used when empty."
        value={p.posterId ?? null}
        onChange={(posterId) => set({ posterId })}
        error={err("posterId")}
      />
      <TextInputField
        label="Caption"
        value={p.caption ?? ""}
        maxLength={200}
        onChange={(caption) => set({ caption })}
        error={err("caption")}
      />
      <ChoiceField
        label="Shape"
        value={p.aspect}
        onChange={(aspect) => set({ aspect })}
        options={[
          { value: "16:9", label: "16:9" },
          { value: "4:3", label: "4:3" },
          { value: "1:1", label: "Square" },
          { value: "9:16", label: "Vertical" },
        ]}
      />
    </>
  ),
  gallery: (props) => {
    const { p, set, err, ctx } = props;
    return (
      <>
        <Eyebrow p={props.p} set={props.set} err={props.err} />
        <GalleryField
          value={p.images}
          onChange={(images) => set({ images })}
          media={ctx.media}
          rememberMedia={ctx.rememberMedia}
          error={err("images")}
        />
        <ChoiceField
          label="Layout"
          value={p.layout}
          onChange={(layout) => set({ layout })}
          options={[
            { value: "grid", label: "Grid" },
            { value: "masonry", label: "Masonry" },
            { value: "carousel", label: "Carousel" },
          ]}
        />
        {p.layout !== "carousel" && (
          <ChoiceField
            label="Columns on wide screens"
            value={String(p.columns ?? 3) as "2" | "3" | "4"}
            onChange={(c) => set({ columns: Number(c) })}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
              { value: "4", label: "4" },
            ]}
          />
        )}
      </>
    );
  },
  map: ({ p, set, err }) => (
    <>
      <TextInputField
        label="Heading"
        value={p.heading ?? ""}
        maxLength={120}
        onChange={(heading) => set({ heading })}
        error={err("heading")}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField
          label="Centre latitude"
          value={p.center?.lat ?? null}
          step={0.0001}
          placeholder="Market centre"
          onChange={(lat) =>
            set({ center: lat === null ? null : { lat, lng: p.center?.lng ?? 0 } })
          }
          error={err("center.lat")}
        />
        <NumberField
          label="Centre longitude"
          value={p.center?.lng ?? null}
          step={0.0001}
          placeholder="Market centre"
          onChange={(lng) =>
            set({ center: lng === null ? null : { lng, lat: p.center?.lat ?? 0 } })
          }
          error={err("center.lng")}
        />
      </div>
      <p className="-mt-2 text-[12.5px] text-text-muted">
        Leave empty to use the map centre from Settings → Market.
      </p>
      <Count label="Zoom" value={p.zoom} onChange={(zoom) => set({ zoom })} min={2} max={18} />
      <SwitchField
        label="Show listings"
        checked={p.showListings ?? true}
        onChange={(showListings) => set({ showListings })}
      />
      <SwitchField
        label="Show nearby places"
        checked={p.showPois ?? false}
        onChange={(showPois) => set({ showPois })}
      />
      <SwitchField
        label="Show the office"
        checked={p.showOffice ?? true}
        onChange={(showOffice) => set({ showOffice })}
      />
      <ChoiceField
        label="Height"
        value={p.height}
        onChange={(height) => set({ height })}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
        ]}
      />
    </>
  ),
  divider: ({ p, set }) => (
    <>
      <ChoiceField
        label="Size"
        value={p.size}
        onChange={(size) => set({ size })}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
        ]}
      />
      <SwitchField
        label="Show a line"
        checked={p.line ?? true}
        onChange={(line) => set({ line })}
      />
    </>
  ),
  custom_html: ({ p, set, err, ctx }) => (
    <>
      <TextInputField
        label="Name in the section list"
        description="Only you see this, e.g. “Booking widget”."
        value={p.label ?? ""}
        maxLength={80}
        onChange={(label) => set({ label })}
        error={err("label")}
      />
      <TextareaField
        label="HTML"
        rows={10}
        value={p.html ?? ""}
        maxLength={20_000}
        onChange={(html) => set({ html })}
        error={err("html")}
      />
      <p className="rounded-lg bg-surface-soft p-3 text-[12.5px] text-text-muted">
        {ctx.allowScripts
          ? "Scripts in this HTML run for every visitor (Settings → Security allows them). Paste code only from services you trust."
          : "The HTML is cleaned when shown: scripts, event handlers, styles blocks and forms are removed, links must be safe. Scripts can be allowed in Settings → Security."}
      </p>
    </>
  ),
};

/** The content fields of one section type. */
export function SectionForm({
  type,
  props,
  onChange,
  errorFor,
  ctx,
}: {
  type: SectionType;
  props: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  errorFor: (field: string) => string | undefined;
  ctx: FormContext;
}) {
  const Form = forms[type] as (p: FormProps<SectionType>) => ReactNode;
  return (
    <div className="flex flex-col gap-4">
      <Form
        p={props as Partial<SectionPropsOf<SectionType>>}
        set={onChange as (patch: Partial<SectionPropsOf<SectionType>>) => void}
        err={(field) => errorFor(`props.${field}`)}
        ctx={ctx}
      />
    </div>
  );
}
