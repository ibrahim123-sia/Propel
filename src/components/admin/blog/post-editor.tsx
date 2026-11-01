"use client";

import { SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { toast } from "sonner";
import { ContentEditorLayout } from "@/components/admin/content/editor-layout";
import { ListingMultiPicker } from "@/components/admin/content/listing-picker";
import { PostBodyEditor } from "@/components/admin/content/post-body-editor";
import { PublishPanel } from "@/components/admin/content/publish-panel";
import { useContentEditor } from "@/components/admin/content/use-content-editor";
import { ListField, SelectField, TextInputField, TextareaField } from "@/components/admin/fields";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { FormSection } from "@/components/admin/page-header";
import { SeoFields } from "@/components/admin/seo-fields";
import { aiSuggestSeo } from "@/features/ai/helper-actions";
import { deletePost, savePost, setPostPublishing } from "@/features/blog/actions";
import type { PostEditorData } from "@/features/blog/queries";
import { postPublishProblems, type PostInput } from "@/features/blog/schema";
import { richTextToPlain } from "@/lib/rich-text";
import { postWordCount, readingMinutes } from "@/lib/rich-text-post";

const sections = [
  { id: "post", label: "Post" },
  { id: "details", label: "Category and author" },
  { id: "related", label: "Related homes" },
  { id: "seo", label: "SEO" },
];

const sectionFor = (field: string) =>
  ["categoryId", "tags", "authorAgentId", "authorUserId"].includes(field)
    ? "details"
    : field === "relatedPropertyIds"
      ? "related"
      : ["slug", "seoTitle", "seoDescription", "canonicalUrl", "ogImageId"].includes(field)
        ? "seo"
        : "post";

/** Byline select values: the agency itself, an agent profile or an admin user. */
const AGENCY = "agency";
const bylineValue = (d: PostInput) =>
  d.authorAgentId ? `agent:${d.authorAgentId}` : d.authorUserId ? `user:${d.authorUserId}` : AGENCY;

/**
 * The post editor (08 §3): title, excerpt, cover, body, category, tags, author, related
 * homes and SEO, with publish / schedule in the side panel. Changes autosave every 10 s.
 */
export function PostEditor({
  data: initial,
  siteName,
  readOnly,
  aiHelpers = false,
}: {
  data: PostEditorData;
  siteName: string;
  readOnly: boolean;
  /** The writing helpers are on (10 §5). */
  aiHelpers?: boolean;
}) {
  const router = useRouter();
  const { id, options } = initial;
  const editor = useContentEditor({
    id,
    noun: "post",
    initial: initial.input,
    status: initial.status,
    publishAt: initial.publishAt,
    publishedAt: initial.publishedAt,
    version: initial.updatedAt,
    readOnly,
    rules: postPublishProblems,
    saveAction: savePost,
    publishAction: setPostPublishing,
  });
  const { data, set, errorFor, errorUnder } = editor;
  const words = postWordCount(data.body);
  const plain = useMemo(() => richTextToPlain(data.body).replace(/\s+/g, " "), [data.body]);

  return (
    <ContentEditorLayout
      sections={sections}
      readOnly={readOnly}
      onSubmit={() => void editor.save("manual")}
      guard={editor.guard}
      panel={
        <PublishPanel
          noun="post"
          status={editor.status}
          publishAt={editor.publishAt}
          publishedAt={editor.publishedAt}
          dirty={editor.dirty}
          saveState={editor.saveState}
          problems={editor.problems}
          sectionFor={sectionFor}
          busy={editor.busy}
          readOnly={readOnly}
          publicPath={`/insights/${editor.saved.slug}`}
          canDelete={editor.status !== "published"}
          deleteDescription="The post and its tags are removed. This cannot be undone."
          onSave={() => void editor.save("manual")}
          onPublish={() => void editor.publishing({ action: "publish" })}
          onSchedule={(at) =>
            void editor.publishing({ action: "schedule", publishAt: at.toISOString() })
          }
          onUnpublish={() => void editor.publishing({ action: "unpublish" })}
          onDelete={async () => {
            const res = await deletePost({ id });
            if (!res.ok) return toast.error(res.error);
            toast.success("Post deleted");
            router.push("/admin/website/blog");
          }}
        >
          <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-text-muted">
            <p>
              <span className="font-semibold text-ink">{readingMinutes(data.body)} min read</span> ·{" "}
              {words} {words === 1 ? "word" : "words"}
            </p>
            <p className="mt-1">
              {initial.viewsCount} {initial.viewsCount === 1 ? "view" : "views"}
            </p>
          </div>
        </PublishPanel>
      }
    >
      {initial.isAiDrafted && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-accent-soft px-4 py-2 text-[13px] text-ink">
          <SparklesIcon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          Drafted by the AI assistant. Check every fact and number before publishing; it is never
          published without you.
        </p>
      )}

      <FormSection id="post" title="Post">
        <TextInputField
          label="Title"
          required
          maxLength={160}
          value={data.title}
          onChange={(title) => set({ title })}
          error={errorFor("title")}
        />
        <TextareaField
          label="Excerpt"
          description="One or two sentences for the post list and search results."
          rows={3}
          maxLength={320}
          value={data.excerpt ?? ""}
          onChange={(v) => set({ excerpt: v || null })}
          error={errorFor("excerpt")}
        />
        <MediaPicker
          label="Cover image"
          description="Shown at the top of the post and on its card. Landscape works best."
          value={data.coverId}
          onChange={(coverId) => set({ coverId })}
          error={errorFor("coverId")}
          disabled={readOnly}
        />
        <PostBodyEditor
          label="Text"
          value={data.body}
          onChange={(body) => set({ body })}
          error={errorUnder("body")}
          placeholder="Write the post…"
          disabled={readOnly}
        />
      </FormSection>

      <FormSection id="details" title="Category and author">
        <SelectField
          label="Category"
          value={data.categoryId ?? "none"}
          onChange={(v) => set({ categoryId: v === "none" ? null : v })}
          options={[
            { value: "none", label: "No category" },
            ...options.categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
          error={errorFor("categoryId")}
          disabled={readOnly}
        />
        <ListField
          label="Tags"
          placeholder="Type a tag, then Enter"
          suggestions={options.tags}
          max={15}
          value={data.tags}
          onChange={(tags) => set({ tags })}
          error={errorUnder("tags")}
        />
        <SelectField
          label="Author"
          description="Shown on the post. An agent profile links to their page."
          value={bylineValue(data)}
          onChange={(v) => {
            const [kind, value] = v.split(":");
            set({
              authorAgentId: kind === "agent" ? value! : null,
              authorUserId: kind === "user" ? value! : null,
            });
          }}
          options={[
            { value: AGENCY, label: `${siteName} (no person)` },
            ...options.bylines.agents.map((a) => ({
              value: `agent:${a.id}`,
              label: a.isActive ? `${a.name} (agent)` : `${a.name} (agent, hidden)`,
            })),
            ...options.bylines.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
          ]}
          error={errorFor("authorAgentId") ?? errorFor("authorUserId")}
          disabled={readOnly}
        />
      </FormSection>

      <FormSection
        id="related"
        title="Related homes"
        description="Shown under the post. Listings that are not on the site are skipped."
      >
        <ListingMultiPicker
          label="Listings"
          value={data.relatedPropertyIds}
          onChange={(relatedPropertyIds) => set({ relatedPropertyIds })}
          known={options.related}
          error={errorUnder("relatedPropertyIds")}
          disabled={readOnly}
        />
      </FormSection>

      <FormSection id="seo" title="SEO">
        <SeoFields
          values={data}
          onChange={(patch) => set(patch)}
          urlPrefix="/insights/"
          fallbackTitle={`${data.title || "Post"} | ${siteName}`}
          fallbackDescription={(data.excerpt || plain).slice(0, 155) || undefined}
          siteName={siteName}
          errorFor={errorFor}
          aiSuggest={
            aiHelpers && !readOnly
              ? () =>
                  aiSuggestSeo({
                    kind: "blog post",
                    title: data.title,
                    text: `${data.excerpt ?? ""} ${plain}`.slice(0, 20_000),
                  })
              : undefined
          }
        />
      </FormSection>
    </ContentEditorLayout>
  );
}
