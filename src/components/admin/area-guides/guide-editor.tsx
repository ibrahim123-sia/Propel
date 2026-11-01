"use client";

import { ArrowDownIcon, ArrowUpIcon, ImagePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ContentEditorLayout } from "@/components/admin/content/editor-layout";
import { PostBodyEditor } from "@/components/admin/content/post-body-editor";
import { PublishPanel } from "@/components/admin/content/publish-panel";
import { useContentEditor } from "@/components/admin/content/use-content-editor";
import {
  CheckboxListField,
  ListField,
  SwitchField,
  TextInputField,
  TextareaField,
} from "@/components/admin/fields";
import { MediaPicker, MediaPickerDialog } from "@/components/admin/media/media-picker";
import { FormSection } from "@/components/admin/page-header";
import { newUnitTypeId as newClientId } from "@/components/admin/projects/editor/unit-types-section";
import { LocationSelect } from "@/components/admin/properties/editor/location-select";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { SeoFields } from "@/components/admin/seo-fields";
import { aiSuggestSeo } from "@/features/ai/helper-actions";
import { Button } from "@/components/ui/button";
import { contentStatusLabels } from "@/features/content/schema";
import { deleteGuide, saveGuide, setGuidePublishing } from "@/features/area-guides/actions";
import type { GuideEditorData } from "@/features/area-guides/queries";
import { guidePublishProblems } from "@/features/area-guides/schema";
import { emptyDoc, richTextToPlain } from "@/lib/rich-text";

const sections = [
  { id: "guide", label: "Guide" },
  { id: "living", label: "Living here" },
  { id: "numbers", label: "At a glance" },
  { id: "photos", label: "Photos" },
  { id: "faqs", label: "Questions" },
  { id: "related", label: "Related posts" },
  { id: "seo", label: "SEO" },
];

const sectionFor = (field: string) =>
  field.startsWith("faqs")
    ? "faqs"
    : field.startsWith("stats")
      ? "numbers"
      : field.startsWith("gallery")
        ? "photos"
        : field === "highlights"
          ? "living"
          : field === "relatedPostIds"
            ? "related"
            : ["slug", "seoTitle", "seoDescription", "canonicalUrl", "ogImageId"].includes(field)
              ? "seo"
              : "guide";

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Up, down and remove for one row of a list. */
function RowTools({
  name,
  index,
  count,
  onMove,
  onRemove,
  disabled,
}: {
  name: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="flex shrink-0 gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} up`}
        disabled={disabled || index === 0}
        onClick={() => onMove(index - 1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} down`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </span>
  );
}

function Row({ label, children, tools }: { label: string; children: ReactNode; tools: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        {tools}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/**
 * The area guide editor (08 §4): area, intro, body, cover, photos, lifestyle highlights,
 * numbers with their sources, the guide's own questions, related posts and SEO. Live counts
 * from the listings are added on the site. Autosaves every 10 s.
 */
export function GuideEditor({
  data: initial,
  siteName,
  readOnly,
  aiHelpers = false,
}: {
  data: GuideEditorData;
  siteName: string;
  readOnly: boolean;
  /** The writing helpers are on (10 §5). */
  aiHelpers?: boolean;
}) {
  const router = useRouter();
  const { id, options } = initial;
  const [photoUrls, setPhotoUrls] = useState(initial.photoUrls);
  const [picking, setPicking] = useState(false);
  const editor = useContentEditor({
    id,
    noun: "guide",
    initial: initial.input,
    status: initial.status,
    publishAt: initial.publishAt,
    publishedAt: initial.publishedAt,
    version: initial.updatedAt,
    readOnly,
    rules: guidePublishProblems,
    saveAction: saveGuide,
    publishAction: setGuidePublishing,
  });
  const { data, set, errorFor, errorUnder } = editor;
  const area = options.locations.find((l) => l.id === data.locationId);

  return (
    <ContentEditorLayout
      sections={sections}
      readOnly={readOnly}
      onSubmit={() => void editor.save("manual")}
      guard={editor.guard}
      panel={
        <PublishPanel
          noun="area guide"
          status={editor.status}
          publishAt={editor.publishAt}
          publishedAt={editor.publishedAt}
          dirty={editor.dirty}
          saveState={editor.saveState}
          problems={editor.problems}
          sectionFor={sectionFor}
          busy={editor.busy}
          readOnly={readOnly}
          publicPath={`/areas/${editor.saved.slug}`}
          canDelete={editor.status !== "published"}
          deleteDescription="The guide, its photos list and its questions are removed. This cannot be undone."
          onSave={() => void editor.save("manual")}
          onPublish={() => void editor.publishing({ action: "publish" })}
          onSchedule={(at) =>
            void editor.publishing({ action: "schedule", publishAt: at.toISOString() })
          }
          onUnpublish={() => void editor.publishing({ action: "unpublish" })}
          onDelete={async () => {
            const res = await deleteGuide({ id });
            if (!res.ok) return toast.error(res.error);
            toast.success("Area guide deleted");
            router.push("/admin/website/area-guides");
          }}
        >
          <p className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-text-muted">
            The page adds live numbers from your listings: homes for sale and to rent, and the
            average asking price per area.
          </p>
        </PublishPanel>
      }
    >
      <FormSection id="guide" title="Guide">
        <TextInputField
          label="Title"
          required
          maxLength={160}
          value={data.title}
          onChange={(title) => set({ title })}
          error={errorFor("title")}
        />
        <LocationSelect
          label="Area"
          required
          nodes={options.locations}
          value={data.locationId}
          onChange={(locationId) => locationId && set({ locationId })}
          error={errorFor("locationId")}
          disabled={readOnly}
        />
        <TextareaField
          label="Intro"
          description={`A short paragraph. It also opens the ${area?.name ?? "area"} search pages (homes for sale and to rent).`}
          rows={4}
          maxLength={600}
          value={data.intro ?? ""}
          onChange={(v) => set({ intro: v || null })}
          error={errorFor("intro")}
        />
        <MediaPicker
          label="Cover image"
          value={data.coverId}
          onChange={(coverId) => set({ coverId })}
          error={errorFor("coverId")}
          disabled={readOnly}
        />
        <PostBodyEditor
          label="Guide text"
          value={data.body}
          onChange={(body) => set({ body })}
          error={errorUnder("body")}
          placeholder="What it is like to live here…"
          disabled={readOnly}
        />
      </FormSection>

      <FormSection id="living" title="Living here" description="Short lifestyle highlights.">
        <ListField
          label="Highlights"
          placeholder="e.g. Ten minutes' walk to the beach"
          max={12}
          value={data.highlights}
          onChange={(highlights) => set({ highlights })}
          error={errorUnder("highlights")}
        />
      </FormSection>

      <FormSection
        id="numbers"
        title="At a glance"
        description="Numbers you enter yourself. Each one shows its source on the page."
        actions={
          !readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={data.stats.length >= 12}
              onClick={() => set({ stats: [...data.stats, { label: "", value: "", source: "" }] })}
            >
              <PlusIcon /> Add a number
            </Button>
          )
        }
      >
        {data.stats.length === 0 && (
          <p className="text-[13px] text-text-muted">
            For example: average rent yield, schools within 2 km, metro stations.
          </p>
        )}
        {data.stats.map((s, i) => {
          const patch = (p: Partial<typeof s>) =>
            set({ stats: data.stats.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <Row
              key={i}
              label={`Number ${i + 1}`}
              tools={
                <RowTools
                  name={`number ${i + 1}`}
                  index={i}
                  count={data.stats.length}
                  disabled={readOnly}
                  onMove={(to) => set({ stats: move(data.stats, i, to) })}
                  onRemove={() => set({ stats: data.stats.filter((_, j) => j !== i) })}
                />
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <TextInputField
                  label="Label"
                  maxLength={60}
                  placeholder="e.g. Average rent yield"
                  value={s.label}
                  onChange={(label) => patch({ label })}
                  error={errorFor(`stats.${i}.label`)}
                />
                <TextInputField
                  label="Value"
                  maxLength={40}
                  placeholder="e.g. 6.1%"
                  value={s.value}
                  onChange={(value) => patch({ value })}
                  error={errorFor(`stats.${i}.value`)}
                />
              </div>
              <TextInputField
                label="Source"
                maxLength={200}
                placeholder="e.g. Land department, 2025 rental index"
                value={s.source}
                onChange={(source) => patch({ source })}
                error={errorFor(`stats.${i}.source`)}
              />
            </Row>
          );
        })}
      </FormSection>

      <FormSection
        id="photos"
        title="Photos"
        description="A gallery of the area, in this order."
        actions={
          !readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={data.gallery.length >= 30}
              onClick={() => setPicking(true)}
            >
              <ImagePlusIcon /> Add a photo
            </Button>
          )
        }
      >
        {data.gallery.length === 0 && <p className="text-[13px] text-text-muted">No photos yet.</p>}
        {data.gallery.map((p, i) => {
          const patch = (x: Partial<typeof p>) =>
            set({ gallery: data.gallery.map((g, j) => (j === i ? { ...g, ...x } : g)) });
          const url = photoUrls[p.mediaId];
          return (
            <Row
              key={p.mediaId}
              label={`Photo ${i + 1}`}
              tools={
                <RowTools
                  name={`photo ${i + 1}`}
                  index={i}
                  count={data.gallery.length}
                  disabled={readOnly}
                  onMove={(to) => set({ gallery: move(data.gallery, i, to) })}
                  onRemove={() => set({ gallery: data.gallery.filter((_, j) => j !== i) })}
                />
              }
            >
              <div className="flex gap-3">
                <div className="h-20 w-28 shrink-0 overflow-hidden rounded-md bg-photo-placeholder">
                  {url && (
                    // eslint-disable-next-line @next/next/no-img-element -- /media resizes on its own
                    <img
                      src={url.endsWith(".svg") ? url : `${url}?w=256&q=60`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <TextInputField
                    label="Alt text"
                    maxLength={300}
                    placeholder="Empty: the library's alt text is used"
                    value={p.alt ?? ""}
                    onChange={(v) => patch({ alt: v || null })}
                  />
                  <TextInputField
                    label="Caption"
                    maxLength={200}
                    value={p.caption ?? ""}
                    onChange={(v) => patch({ caption: v || null })}
                  />
                </div>
              </div>
            </Row>
          );
        })}
        {errorUnder("gallery") && (
          <p role="alert" className="text-[12.5px] font-medium text-danger">
            {errorUnder("gallery")}
          </p>
        )}
      </FormSection>

      <FormSection
        id="faqs"
        title="Questions"
        description="Shown on this guide and on the area's search pages (with FAQ structured data)."
        actions={
          !readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={data.faqs.length >= 30}
              onClick={() =>
                set({
                  faqs: [
                    ...data.faqs,
                    { id: newClientId(), question: "", answer: emptyDoc(), isPublished: true },
                  ],
                })
              }
            >
              <PlusIcon /> Add a question
            </Button>
          )
        }
      >
        {data.faqs.length === 0 && (
          <p className="text-[13px] text-text-muted">
            Questions buyers and tenants ask about this area.
          </p>
        )}
        {data.faqs.map((f, i) => {
          const patch = (x: Partial<typeof f>) =>
            set({ faqs: data.faqs.map((q, j) => (j === i ? { ...q, ...x } : q)) });
          return (
            <Row
              key={f.id}
              label={`Question ${i + 1}`}
              tools={
                <RowTools
                  name={`question ${i + 1}`}
                  index={i}
                  count={data.faqs.length}
                  disabled={readOnly}
                  onMove={(to) => set({ faqs: move(data.faqs, i, to) })}
                  onRemove={() => set({ faqs: data.faqs.filter((_, j) => j !== i) })}
                />
              }
            >
              <TextInputField
                label="Question"
                maxLength={200}
                value={f.question}
                onChange={(question) => patch({ question })}
                error={errorFor(`faqs.${i}.question`)}
              />
              <RichTextEditor
                label="Answer"
                value={f.answer}
                onChange={(answer) => patch({ answer })}
                error={errorUnder(`faqs.${i}.answer`)}
                disabled={readOnly}
              />
              <SwitchField
                label="Show on the site"
                checked={f.isPublished}
                onChange={(isPublished) => patch({ isPublished })}
                disabled={readOnly}
              />
            </Row>
          );
        })}
        {errorFor("faqs") && (
          <p role="alert" className="text-[12.5px] font-medium text-danger">
            {errorFor("faqs")}
          </p>
        )}
      </FormSection>

      <FormSection id="related" title="Related posts" description="Up to six, shown at the end.">
        {options.posts.length === 0 ? (
          <p className="text-[13px] text-text-muted">No posts yet.</p>
        ) : (
          <CheckboxListField
            label="Posts"
            columns={1}
            value={data.relatedPostIds}
            onChange={(relatedPostIds) => set({ relatedPostIds })}
            options={options.posts.map((p) => ({
              value: p.id,
              label:
                p.status === "published"
                  ? p.title
                  : `${p.title} (${contentStatusLabels[p.status]})`,
            }))}
            error={errorUnder("relatedPostIds")}
          />
        )}
      </FormSection>

      <FormSection id="seo" title="SEO">
        <SeoFields
          values={data}
          onChange={(patch) => set(patch)}
          urlPrefix="/areas/"
          fallbackTitle={`Living in ${area?.name ?? data.title}: area guide | ${siteName}`}
          fallbackDescription={
            (data.intro || richTextToPlain(data.body)).slice(0, 155) || undefined
          }
          siteName={siteName}
          errorFor={errorFor}
          aiSuggest={
            aiHelpers && !readOnly
              ? () =>
                  aiSuggestSeo({
                    kind: "area guide",
                    title: area?.name ?? data.title,
                    text: `${data.intro ?? ""} ${richTextToPlain(data.body)}`.slice(0, 20_000),
                  })
              : undefined
          }
        />
      </FormSection>

      {picking && (
        <MediaPickerDialog
          type="image"
          selectedId={null}
          onClose={() => setPicking(false)}
          onPick={(item) => {
            setPicking(false);
            if (data.gallery.some((g) => g.mediaId === item.id)) return;
            setPhotoUrls((m) => ({ ...m, [item.id]: item.url }));
            set({ gallery: [...data.gallery, { mediaId: item.id, caption: null, alt: null }] });
          }}
        />
      )}
    </ContentEditorLayout>
  );
}
