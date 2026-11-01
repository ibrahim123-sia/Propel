"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { FormSection } from "@/components/admin/page-header";
import { NearbyPlaces, type NearbyActions } from "@/components/admin/properties/nearby-places";
import type { SaveState } from "@/components/admin/properties/editor/editor-panel";
import { useUnsavedGuard } from "@/components/admin/properties/editor/use-unsaved-guard";
import { adminBrochurePath } from "@/features/brochure/paths";
import { getMediaStatuses } from "@/features/media/actions";
import type { MediaItem } from "@/features/media/queries";
import { planProblem } from "@/features/payment-plans/schema";
import type { PropertyPoisView } from "@/features/pois/nearby-queries";
import { deleteProject, saveProject, setProjectPublished } from "@/features/projects/actions";
import {
  recalculateProjectPois,
  reorderProjectPois,
  updateProjectPoi,
} from "@/features/projects/nearby-actions";
import type { ProjectActivity, ProjectEditorOptions } from "@/features/projects/editor-data";
import { projectPublishProblems, type ProjectInput } from "@/features/projects/schema";
import { CreateListingsDialog } from "./create-listings-dialog";
import { ProjectPanel } from "./project-panel";
import {
  ActivitySection,
  BasicsSection,
  DatesSection,
  DescriptionSection,
  FacilitiesSection,
  ListingsSection,
  PlanSection,
  PricingSection,
  ProjectMediaSection,
  SeoSection,
} from "./sections";
import type { ProjectEditorMarket, ProjectSectionProps } from "./types";
import { UnitTypesSection } from "./unit-types-section";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const projectNearbyActions: NearbyActions = {
  recalculate: (projectId) => recalculateProjectPois({ projectId }),
  update: (input) => updateProjectPoi(input),
  reorder: (projectId, ids) => reorderProjectPois({ projectId, ids }),
};

const sections = [
  { id: "basics", label: "Basics" },
  { id: "dates", label: "Dates and progress" },
  { id: "pricing", label: "Pricing" },
  { id: "description", label: "Description" },
  { id: "media", label: "Media" },
  { id: "facilities", label: "Facilities" },
  { id: "units", label: "Unit types" },
  { id: "plan", label: "Payment plan" },
  { id: "nearby", label: "Nearby" },
  { id: "seo", label: "SEO" },
  { id: "listings", label: "Listings" },
  { id: "activity", label: "Activity" },
];

/**
 * The project editor (07 §6): section nav, sections, and a sticky panel with publishing and
 * save state. Changes autosave every 10 seconds.
 */
export function ProjectEditor({
  id,
  initial,
  initialUpdatedAt,
  initialPublished,
  progressUpdatedAt,
  media: initialMedia,
  options,
  activity,
  nearby,
  market,
  readOnly,
  aiHelpers = false,
}: {
  id: string;
  initial: ProjectInput;
  initialUpdatedAt: string;
  initialPublished: boolean;
  progressUpdatedAt: string | null;
  media: Record<string, MediaItem>;
  options: ProjectEditorOptions;
  activity: ProjectActivity;
  nearby: PropertyPoisView;
  market: ProjectEditorMarket;
  readOnly: boolean;
  /** The writing helpers are on (10 §5). */
  aiHelpers?: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [published, setPublished] = useState(initialPublished);
  const [mediaMap, setMediaMap] = useState(initialMedia);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const dirty = !same(data, saved);
  const problems = useMemo(
    () =>
      projectPublishProblems(data, {
        libraryAlt: new Map(Object.values(mediaMap).map((m) => [m.id, m.alt || null])),
        planProblem: data.paymentPlan ? planProblem(data.paymentPlan.steps) : null,
      }),
    [data, mediaMap],
  );

  // Latest values for the autosave timer and keyboard shortcut.
  const ref = useRef({
    data,
    saved,
    published,
    problems,
    version: initialUpdatedAt,
    saving: false,
  });
  useEffect(() => {
    ref.current.data = data;
    ref.current.saved = saved;
    ref.current.published = published;
    ref.current.problems = problems;
  });

  const save = useCallback(
    async (mode: "auto" | "manual"): Promise<boolean> => {
      const r = ref.current;
      if (readOnly || r.saving) return false;
      const snapshot = r.data;
      if (same(snapshot, r.saved)) return true;
      if (r.published && r.problems.length > 0) {
        setSaveState({ kind: "blocked" });
        if (mode === "manual")
          toast.error("This project is published, so these must stay filled in.", {
            description: r.problems.map((p) => p.message).join("\n"),
          });
        return false;
      }
      r.saving = true;
      setSaveState({ kind: "saving" });
      const res = await saveProject({ id, data: snapshot, expectedUpdatedAt: r.version });
      r.saving = false;
      if (res.ok) {
        r.version = res.data.updatedAt;
        const stored = { ...snapshot, slug: res.data.slug };
        r.saved = stored;
        setSaved(stored);
        setData((d) => (d.slug === snapshot.slug ? { ...d, slug: res.data.slug } : d));
        setFieldErrors({});
        setSaveState({ kind: "saved", at: new Date().toISOString() });
        return true;
      }
      setFieldErrors(res.fieldErrors ?? {});
      setSaveState({ kind: res.code === "CONFLICT" ? "conflict" : "error", message: res.error });
      if (mode === "manual" || res.code === "CONFLICT") toast.error(res.error);
      return false;
    },
    [id, readOnly],
  );

  useEffect(() => {
    if (readOnly) return;
    const timer = setInterval(() => void save("auto"), 10_000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save("manual");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [save, readOnly]);

  // New uploads finish processing in the background: refresh their thumbnails.
  const processingKey = Object.values(mediaMap)
    .filter((m) => m.status === "processing" || m.status === "uploading")
    .map((m) => m.id)
    .join(",");
  useEffect(() => {
    if (!processingKey) return;
    const timer = setInterval(async () => {
      const res = await getMediaStatuses({ ids: processingKey.split(",") });
      if (res.ok)
        setMediaMap((m) => ({ ...m, ...Object.fromEntries(res.data.map((i) => [i.id, i])) }));
    }, 3000);
    return () => clearInterval(timer);
  }, [processingKey]);

  async function changePublished(next: boolean) {
    if (dirty && !(await save("manual"))) return;
    setBusy(true);
    const res = await setProjectPublished({ id, published: next });
    setBusy(false);
    if (!res.ok) {
      setFieldErrors(res.fieldErrors ?? {});
      toast.error(res.error, {
        description: Object.values(res.fieldErrors ?? {})
          .flat()
          .join("\n"),
      });
      return;
    }
    ref.current.version = res.data.updatedAt;
    setPublished(next);
    toast.success(next ? `${data.name} is published` : `${data.name} is no longer published`);
    router.refresh();
  }

  const guard = useUnsavedGuard(dirty);
  const set = useCallback(
    (patch: Partial<ProjectInput>) => setData((d) => ({ ...d, ...patch })),
    [],
  );
  const errorFor = useCallback((field: string) => fieldErrors[field]?.[0], [fieldErrors]);
  const rememberMedia = useCallback(
    (items: MediaItem[]) =>
      setMediaMap((m) => ({ ...m, ...Object.fromEntries(items.map((i) => [i.id, i])) })),
    [],
  );
  const props: ProjectSectionProps = {
    data,
    set,
    errorFor,
    options,
    market,
    media: mediaMap,
    rememberMedia,
    activity,
    readOnly,
    aiHelpers: aiHelpers && !readOnly,
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[10rem_minmax(0,1fr)_18rem]">
      <nav aria-label="Sections" className="sticky top-20 hidden lg:block">
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="block rounded-md px-2 py-1 text-text-muted hover:bg-surface-muted hover:text-ink"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <form
        className="order-2 flex min-w-0 flex-col gap-5 lg:order-none"
        onSubmit={(e) => {
          e.preventDefault();
          void save("manual");
        }}
      >
        {readOnly && (
          <p className="rounded-lg border border-border bg-surface-soft px-4 py-2 text-[13px] text-text-muted">
            You can look around, but changes are not saved in this account.
          </p>
        )}
        <BasicsSection {...props} />
        <DatesSection
          {...props}
          progressUpdatedAt={progressUpdatedAt}
          progressChanged={data.constructionProgress !== saved.constructionProgress}
        />
        <PricingSection {...props} />
        <DescriptionSection {...props} />
        <ProjectMediaSection {...props} />
        <FacilitiesSection {...props} />
        <UnitTypesSection {...props} onCreateListings={() => setCreating(true)} />
        <PlanSection {...props} />
        <FormSection
          id="nearby"
          title="Nearby"
          description="Schools, shops and transport measured from the saved map pin. Moving the pin measures them again."
        >
          <NearbyPlaces
            propertyId={id}
            initial={nearby}
            hasPin={Boolean(saved.point)}
            distanceUnit={market.distanceUnit}
            readOnly={readOnly}
            actions={projectNearbyActions}
          />
        </FormSection>
        <SeoSection {...props} />
        <ListingsSection {...props} onCreate={() => setCreating(true)} />
        <ActivitySection {...props} />
      </form>

      <div className="order-1 lg:sticky lg:top-20 lg:order-none">
        <ProjectPanel
          published={published}
          dirty={dirty}
          saveState={saveState}
          problems={problems}
          busy={busy}
          readOnly={readOnly}
          publicPath={`/projects/${saved.slug}`}
          brochurePath={adminBrochurePath("project", id)}
          canDelete={!published && activity.listings.length === 0}
          onSave={() => void save("manual")}
          onPublish={(next) => void changePublished(next)}
          onDelete={async () => {
            const res = await deleteProject({ id });
            if (!res.ok) return toast.error(res.error);
            toast.success("Project deleted");
            router.push("/admin/projects");
          }}
        />
      </div>

      <CreateListingsDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={id}
        unitTypes={data.unitTypes}
        propertyTypes={options.propertyTypes}
        ensureSaved={() => save("manual")}
        onCreated={() => router.refresh()}
      />

      <ConfirmDialog
        open={guard.pending !== null}
        onOpenChange={(o) => !o && guard.cancel()}
        title="Leave without saving?"
        description="Your latest changes are not saved yet."
        confirmLabel="Leave"
        destructive
        onConfirm={guard.leave}
      />
    </div>
  );
}
