"use client";

import { useId, useState, type ComponentProps } from "react";
import { cn } from "cn";
import { SwitchField, TextInputField } from "@/components/admin/fields";
import { SeoFields, type SeoValues } from "@/components/admin/seo-fields";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { pageTemplates } from "@/db/schema/cms";
import {
  pageTemplateHelp,
  pageTemplateLabels,
  type PageSettings,
  type PageTemplate,
} from "@/features/cms/page-schema";
import { slugify } from "@/lib/slug";

export type SettingsValues = PageSettings;

/**
 * Page settings (08 §1 top bar, 08 §6 SEO panel): title, address, template and SEO. Saved
 * with its own button and applied at once; a new address on a published page adds a 301.
 */
export function PageSettingsSheet({
  open,
  onOpenChange,
  initial,
  isHome,
  published,
  siteName,
  fallbackDescription,
  onSave,
  readOnly,
  aiSuggest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: SettingsValues;
  isHome: boolean;
  /** Published at least once: slug changes then redirect, and the slug no longer follows the title. */
  published: boolean;
  siteName: string;
  fallbackDescription: string;
  onSave: (values: SettingsValues) => Promise<Record<string, string[]> | null>;
  readOnly: boolean;
  /** AI title and description suggestions; omitted when the writing helpers are off. */
  aiSuggest?: ComponentProps<typeof SeoFields>["aiSuggest"];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Page settings</SheetTitle>
          <SheetDescription>
            Title, address, template and how the page shows in search.
          </SheetDescription>
        </SheetHeader>
        {open && (
          <SettingsForm
            initial={initial}
            isHome={isHome}
            published={published}
            siteName={siteName}
            fallbackDescription={fallbackDescription}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
            readOnly={readOnly}
            aiSuggest={readOnly ? undefined : aiSuggest}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SettingsForm({
  initial,
  isHome,
  published,
  siteName,
  fallbackDescription,
  onSave,
  onCancel,
  readOnly,
  aiSuggest,
}: {
  initial: SettingsValues;
  isHome: boolean;
  published: boolean;
  siteName: string;
  fallbackDescription: string;
  onSave: (values: SettingsValues) => Promise<Record<string, string[]> | null>;
  onCancel: () => void;
  readOnly: boolean;
  /** AI title and description suggestions; omitted when the writing helpers are off. */
  aiSuggest?: ComponentProps<typeof SeoFields>["aiSuggest"];
}) {
  const formId = useId();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  // Until the page is first published, the address follows the title (unless edited by hand).
  const [followTitle, setFollowTitle] = useState(
    !published && !isHome && initial.slug === slugify(initial.title),
  );
  const err = (f: string) => errors[f]?.[0];
  const seo: SeoValues = {
    slug: values.slug,
    seoTitle: values.seoTitle,
    seoDescription: values.seoDescription,
    canonicalUrl: values.canonicalUrl,
    noindex: values.noindex,
    ogImageId: values.ogImageId,
  };
  return (
    <>
      <form
        id={formId}
        className="flex-1 overflow-y-auto px-4 py-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await onSave(values);
          setBusy(false);
          setErrors(res ?? {});
        }}
      >
        <fieldset disabled={readOnly} className="flex flex-col gap-5">
          <TextInputField
            label="Title"
            required
            maxLength={120}
            value={values.title}
            onChange={(title) =>
              setValues((v) => ({ ...v, title, ...(followTitle ? { slug: slugify(title) } : {}) }))
            }
            error={err("title")}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-semibold text-ink">Template</legend>
            {isHome && (
              <p className="text-[12.5px] text-text-muted">
                The home page always uses the default template.
              </p>
            )}
            {pageTemplates.map((t: PageTemplate) => (
              <label
                key={t}
                className={cn(
                  "flex gap-3 rounded-lg border p-3 text-[13px]",
                  isHome ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  values.template === t ? "border-ink bg-surface-soft" : "border-border",
                )}
              >
                <input
                  type="radio"
                  name={`${formId}-template`}
                  value={t}
                  disabled={isHome}
                  checked={values.template === t}
                  onChange={() => setValues((v) => ({ ...v, template: t }))}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block font-semibold text-ink">{pageTemplateLabels[t]}</span>
                  <span className="text-text-muted">{pageTemplateHelp[t]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <SwitchField
            label="Hide the chat button on this page"
            description="For pages that should keep visitors on one form, such as an ad landing page."
            checked={values.hideChat}
            onChange={(hideChat) => setValues((v) => ({ ...v, hideChat }))}
          />
          <SeoFields
            values={seo}
            onChange={(patch) => {
              if (patch.slug !== undefined) setFollowTitle(false);
              setValues((v) => ({ ...v, ...patch }) as SettingsValues);
            }}
            urlPrefix="/"
            fallbackTitle={values.title}
            fallbackDescription={fallbackDescription}
            siteName={siteName}
            errorFor={err}
            aiSuggest={aiSuggest}
          />
          {!published && (
            <p className="-mt-2 text-[12.5px] text-text-muted">
              Not published yet: changing the address adds no redirect.
            </p>
          )}
        </fieldset>
      </form>
      <SheetFooter className="flex-row justify-end gap-2 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {!readOnly && (
          <Button type="submit" form={formId} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        )}
      </SheetFooter>
    </>
  );
}
