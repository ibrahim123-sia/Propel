"use client";

import {
  ArrowLeftIcon,
  CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  HistoryIcon,
  HomeIcon,
  LinkIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  SmartphoneIcon,
  TabletIcon,
  Undo2Icon,
  EyeOffIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useUnsavedGuard } from "@/components/admin/properties/editor/use-unsaved-guard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createPagePreviewLink,
  discardPageDraft,
  publishPage,
  restorePageRevision,
  savePageDraft,
  savePageSettings,
  schedulePage,
  setHomePage,
  unpublishPage,
} from "@/features/cms/page-actions";
import { aiSuggestSeo } from "@/features/ai/helper-actions";
import type { PageEditorData } from "@/features/cms/page-admin";
import { sectionCatalog } from "@/features/cms/section-catalog";
import { sectionsText } from "@/features/cms/section-text";
import {
  newSectionId,
  sectionProblems,
  stableJson,
  starterSection,
  type EditorSection,
} from "@/features/cms/section-rules";
import {
  isSectionType,
  parseSection,
  sectionInputSchema,
  type SectionStyle,
  type SectionType,
} from "@/features/cms/sections";
import type { MediaItem } from "@/features/media/queries";
import type { ActionResult } from "@/lib/action-result";
import { PageStatusPill, publicPath } from "../pages-manager";
import { PageSettingsSheet, type SettingsValues } from "./page-settings-dialog";
import { PreviewFrame, type Device, type PreviewHandle } from "./preview-frame";
import { RevisionsSheet } from "./revisions-sheet";
import { SectionForm } from "./section-forms";
import { SectionList } from "./section-list";
import { SectionPicker } from "./section-picker";
import { StyleFields } from "./style-fields";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string };

/** Section id -> field path -> messages. */
type Problems = Record<string, Record<string, string[]>>;

const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const longFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** What is missing or wrong in each section, checked as the admin types (same rules as Publish). */
function computeProblems(sections: EditorSection[]): Problems {
  const schema = sectionInputSchema();
  const out: Problems = {};
  for (const s of sections) {
    const parsed = schema.safeParse(s);
    const fields: Record<string, string[]> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        (fields[issue.path.map(String).join(".") || "section"] ??= []).push(issue.message);
    } else {
      for (const p of sectionProblems(parseSection(parsed.data)!))
        (fields[p.field] ??= []).push(p.message);
    }
    if (Object.keys(fields).length) out[s.id] = fields;
  }
  return out;
}

/** Field errors from Publish ("sections.<id>.props.heading") back into per-section problems. */
function problemsFromFieldErrors(fieldErrors: Record<string, string[]> | undefined): Problems {
  const out: Problems = {};
  for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
    const m = key.match(/^sections\.([^.]+)\.(.+)$/);
    if (m) (out[m[1]!] ??= {})[m[2]!] = messages;
  }
  return out;
}

/** Local time for <input type="datetime-local"> and back. */
function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The page builder (08 §1): sections on the left, the live preview in the middle, the selected
 * section's settings on the right; title, settings, revisions, preview link, schedule and
 * Publish at the top. The draft autosaves a moment after each change; the site shows the
 * published version until Publish.
 */
export function PageEditor({
  data,
  previewSrc,
  siteName,
  readOnly,
  aiHelpers = false,
}: {
  data: PageEditorData;
  /** The preview route for this page's draft (signed link, edit mode). */
  previewSrc: string;
  siteName: string;
  readOnly: boolean;
  /** The writing helpers are on (10 §5). */
  aiHelpers?: boolean;
}) {
  const router = useRouter();
  const id = data.page.id;
  const [meta, setMeta] = useState(data.page);
  const [sections, setSections] = useState(data.sections);
  const [saved, setSaved] = useState(data.sections);
  const [hasDraft, setHasDraft] = useState(data.hasDraft);
  const [published, setPublished] = useState(data.hasBeenPublished);
  const [selectedId, setSelectedId] = useState<string | null>(data.sections[0]?.id ?? null);
  const [tab, setTab] = useState<"content" | "style">("content");
  const [device, setDevice] = useState<Device>("desktop");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [publishProblems, setPublishProblems] = useState<Problems>({});
  const [media, setMedia] = useState<Record<string, MediaItem>>(data.media);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [panel, setPanel] = useState<null | "settings" | "revisions">(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [confirm, setConfirm] = useState<null | "discard" | "unpublish">(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"sections" | "preview" | "settings">("sections");

  const preview = useRef<PreviewHandle>(null);
  const version = useRef(data.page.updatedAt);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ sections, saved });
  useEffect(() => {
    latest.current.sections = sections;
  });

  const dirty = stableJson(sections) !== stableJson(saved);
  const problems = useMemo(() => computeProblems(sections), [sections]);
  const selected = sections.find((s) => s.id === selectedId) ?? null;
  const conflict = saveState.kind === "conflict";

  /** Writes run one after another, each with the version the previous one returned. */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(fn, fn);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Calls an action that returns the page's new version token, and keeps the token. */
  const write = useCallback(
    <T extends { updatedAt: string }>(call: (v: string) => Promise<ActionResult<T>>) =>
      enqueue(async () => {
        let res: ActionResult<T>;
        try {
          res = await call(version.current);
        } catch {
          res = { ok: false, error: "Could not reach the server. Your changes are still here." };
        }
        if (res.ok) version.current = res.data.updatedAt;
        else if (res.code === "CONFLICT") setSaveState({ kind: "conflict", message: res.error });
        return res;
      }),
    [enqueue],
  );

  const saveDraft = useCallback(
    async (mode: "auto" | "manual"): Promise<boolean> => {
      if (readOnly) return false;
      const snapshot = latest.current.sections;
      if (stableJson(snapshot) === stableJson(latest.current.saved)) return true;
      setSaveState({ kind: "saving" });
      const res = await write((v) =>
        savePageDraft({ id, expectedUpdatedAt: v, sections: snapshot }),
      );
      if (res.ok) {
        latest.current.saved = snapshot;
        setSaved(snapshot);
        setHasDraft(res.data.hasDraft);
        setSaveState({ kind: "saved", at: new Date().toISOString() });
        preview.current?.refresh();
        return true;
      }
      if (res.code !== "CONFLICT") setSaveState({ kind: "error", message: res.error });
      if (mode === "manual" || res.code === "CONFLICT") toast.error(res.error);
      return false;
    },
    [id, readOnly, write],
  );

  // Autosave a moment after the last change (never over someone else's newer version).
  useEffect(() => {
    if (!dirty || readOnly || conflict) return;
    const t = setTimeout(() => void saveDraft("auto"), 1200);
    return () => clearTimeout(t);
  }, [sections, dirty, readOnly, conflict, saveDraft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveDraft("manual");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveDraft]);

  const guard = useUnsavedGuard(dirty);

  /* Sections -------------------------------------------------------------------------- */

  const select = useCallback((sid: string, from: "list" | "preview") => {
    setSelectedId(sid);
    setTab("content");
    if (from === "list") preview.current?.focus(sid, true);
    else {
      preview.current?.focus(sid, false);
      setView("settings");
      document
        .querySelector(`[data-section-row="${CSS.escape(sid)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const replace = (sid: string, fn: (s: EditorSection) => EditorSection) =>
    setSections((list) => list.map((s) => (s.id === sid ? fn(s) : s)));

  function addSection(type: SectionType) {
    const fresh = starterSection(type);
    setSections((list) => {
      const at = selectedId ? list.findIndex((s) => s.id === selectedId) + 1 : list.length;
      const next = [...list];
      next.splice(at > 0 ? at : list.length, 0, fresh);
      return next;
    });
    setPickerOpen(false);
    setSelectedId(fresh.id);
    setTab("content");
    setView("settings");
  }

  function duplicateSection(sid: string) {
    const copy = { ...structuredClone(sections.find((s) => s.id === sid)!), id: newSectionId() };
    setSections((list) => {
      const next = [...list];
      next.splice(list.findIndex((s) => s.id === sid) + 1, 0, copy);
      return next;
    });
    setSelectedId(copy.id);
  }

  function removeSection(sid: string) {
    const before = sections;
    const index = sections.findIndex((s) => s.id === sid);
    const name = isSectionType(sections[index]?.type)
      ? sectionCatalog[sections[index]!.type as SectionType].label
      : "Section";
    setSections((list) => list.filter((s) => s.id !== sid));
    if (selectedId === sid)
      setSelectedId(sections[index + 1]?.id ?? sections[index - 1]?.id ?? null);
    toast(`${name} removed`, {
      action: { label: "Undo", onClick: () => setSections(before) },
    });
  }

  function moveSection(sid: string, by: -1 | 1) {
    setSections((list) => {
      const i = list.findIndex((s) => s.id === sid);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  /* Page actions ---------------------------------------------------------------------- */

  async function publish() {
    if (dirty && !(await saveDraft("manual"))) return;
    setBusy(true);
    const res = await write((v) => publishPage({ id, expectedUpdatedAt: v }));
    setBusy(false);
    if (!res.ok) {
      const found = problemsFromFieldErrors(res.fieldErrors);
      setPublishProblems(found);
      const firstId = Object.keys(found)[0];
      if (firstId) select(firstId, "list");
      if (res.code !== "CONFLICT") toast.error(res.error);
      return;
    }
    setPublishProblems({});
    latest.current.saved = res.data.sections;
    setSections(res.data.sections);
    setSaved(res.data.sections);
    setHasDraft(false);
    setPublished(true);
    setMeta((m) => ({ ...m, status: "published", publishAt: null, version: res.data.version }));
    toast.success(res.data.firstPublish ? "The page is live" : "Changes published", {
      action: {
        label: "View",
        onClick: () => window.open(publicPath({ slug: meta.slug, isHome: meta.isHome }), "_blank"),
      },
    });
    router.refresh();
  }

  async function saveSettings(values: SettingsValues) {
    const res = await write((v) => savePageSettings({ id, expectedUpdatedAt: v, data: values }));
    if (!res.ok) {
      if (res.code !== "CONFLICT") toast.error(res.error);
      return res.fieldErrors ?? {};
    }
    setMeta((m) => ({ ...m, ...values, slug: res.data.slug, template: res.data.template }));
    toast.success(
      res.data.redirected ? "Saved. The old address now redirects to the new one." : "Saved",
    );
    setPanel(null);
    preview.current?.refresh();
    router.refresh();
    return null;
  }

  async function schedule(at: string | null) {
    if (dirty && !(await saveDraft("manual"))) return false;
    const res = await write((v) => schedulePage({ id, expectedUpdatedAt: v, publishAt: at }));
    if (!res.ok) {
      if (res.code !== "CONFLICT") toast.error(res.error);
      return false;
    }
    setMeta((m) => ({ ...m, status: res.data.status, publishAt: res.data.publishAt }));
    toast.success(
      res.data.publishAt
        ? `Scheduled for ${longFormat.format(new Date(res.data.publishAt))}`
        : "Schedule cancelled",
    );
    return true;
  }

  async function discard() {
    const res = await write((v) => discardPageDraft({ id, expectedUpdatedAt: v }));
    if (!res.ok) return void (res.code !== "CONFLICT" && toast.error(res.error));
    latest.current.saved = res.data.sections;
    setSections(res.data.sections);
    setSaved(res.data.sections);
    setHasDraft(false);
    if (meta.status === "published") setMeta((m) => ({ ...m, publishAt: null }));
    setSelectedId(res.data.sections[0]?.id ?? null);
    toast.success("Back to the published version");
    preview.current?.refresh();
  }

  async function unpublish() {
    const res = await write((v) => unpublishPage({ id, expectedUpdatedAt: v }));
    if (!res.ok) return void (res.code !== "CONFLICT" && toast.error(res.error));
    setMeta((m) => ({ ...m, status: res.data.status, publishAt: null }));
    toast.success("The page is off the site");
    router.refresh();
  }

  async function restore(revisionId: string) {
    if (dirty && !(await saveDraft("manual"))) return false;
    const res = await write((v) =>
      restorePageRevision({ pageId: id, revisionId, expectedUpdatedAt: v }),
    );
    if (!res.ok) {
      if (res.code !== "CONFLICT") toast.error(res.error);
      return false;
    }
    latest.current.saved = res.data.sections;
    setSections(res.data.sections);
    setSaved(res.data.sections);
    setHasDraft(true);
    setSelectedId(res.data.sections[0]?.id ?? null);
    toast.success("Version restored into the draft. Publish to make it live.");
    preview.current?.refresh();
    return true;
  }

  async function makeHome() {
    const res = await write(() => setHomePage({ id }));
    if (!res.ok) return void toast.error(res.error);
    setMeta((m) => ({ ...m, isHome: true, template: "default" }));
    toast.success("This is now the home page");
    router.refresh();
  }

  async function shareLink() {
    const res = await createPagePreviewLink({ id });
    if (!res.ok) return toast.error(res.error);
    setLink(res.data);
  }

  /* Render ---------------------------------------------------------------------------- */

  const live = meta.status === "published";
  const sectionProblemsFor = (sid: string) => ({
    ...problems[sid],
    ...publishProblems[sid],
  });
  const errorFor = (field: string) =>
    selected ? sectionProblemsFor(selected.id)[field]?.[0] : undefined;
  const ctx = {
    options: data.options,
    media,
    rememberMedia: (item: MediaItem) => setMedia((m) => ({ ...m, [item.id]: item })),
    allowScripts: data.allowScripts,
  };

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] flex-col lg:-mx-8">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back to pages">
          <Link href="/admin/website/pages">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-[15px] font-semibold text-ink">
              <span className="truncate">{meta.title}</span>
              {meta.isHome && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-surface">
                  <HomeIcon className="size-3" aria-hidden /> Home
                </span>
              )}
            </h1>
            <p className="truncate text-[12px] text-text-muted">
              {publicPath(meta)}
              {data.legalRole ? ` · ${data.legalRole}` : ""}
            </p>
          </div>
          <PageStatusPill
            status={meta.status}
            hasDraft={hasDraft || dirty}
            publishAt={meta.publishAt}
          />
          <SaveIndicator state={saveState} dirty={dirty} readOnly={readOnly} />
        </div>
        <div
          role="radiogroup"
          aria-label="Preview width"
          className="hidden items-center rounded-lg border border-border p-0.5 md:flex"
        >
          {(
            [
              ["desktop", MonitorIcon, "Desktop"],
              ["tablet", TabletIcon, "Tablet"],
              ["phone", SmartphoneIcon, "Phone"],
            ] as const
          ).map(([d, Icon, label]) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={device === d}
              aria-label={label}
              title={label}
              onClick={() => {
                setDevice(d);
                setView("preview");
              }}
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-text-muted hover:text-ink",
                device === d && "bg-ink text-surface hover:text-surface",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setPanel("settings")}>
          <SettingsIcon /> <span className="hidden sm:inline">Settings</span>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setPanel("revisions")}>
          <HistoryIcon /> <span className="hidden sm:inline">Revisions</span>
        </Button>
        {!readOnly && (
          <Button type="button" variant="outline" size="sm" onClick={() => void shareLink()}>
            <LinkIcon /> <span className="hidden sm:inline">Preview link</span>
          </Button>
        )}
        {!readOnly && (
          <SchedulePopover
            publishAt={meta.publishAt}
            canSchedule={!live || hasDraft || dirty}
            onSchedule={schedule}
          />
        )}
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            disabled={busy || conflict || (live && !hasDraft && !dirty)}
            onClick={() => void publish()}
          >
            <CheckIcon /> {busy ? "Publishing…" : live ? "Publish changes" : "Publish"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="More page actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {live && (
              <DropdownMenuItem asChild>
                <a href={publicPath(meta)} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon /> View on site
                </a>
              </DropdownMenuItem>
            )}
            {!readOnly && live && !meta.isHome && (
              <DropdownMenuItem onSelect={() => void makeHome()}>
                <HomeIcon /> Set as home
              </DropdownMenuItem>
            )}
            {!readOnly && (hasDraft || dirty) && published && (
              <DropdownMenuItem onSelect={() => setConfirm("discard")}>
                <Undo2Icon /> Discard changes
              </DropdownMenuItem>
            )}
            {!readOnly && live && !meta.isHome && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("unpublish")}>
                  <EyeOffIcon /> Unpublish
                </DropdownMenuItem>
              </>
            )}
            {readOnly && <DropdownMenuItem disabled>Read-only: changes are off</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 bg-danger/10 px-4 py-2 text-[13px] text-danger"
        >
          {saveState.message}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      )}

      {/* Phone and tablet admin: one column at a time. */}
      <div
        className="flex border-b border-border bg-surface xl:hidden"
        role="tablist"
        aria-label="Page builder panels"
      >
        {(
          [
            ["sections", "Sections"],
            ["preview", "Preview"],
            ["settings", "Section settings"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              "flex-1 border-b-2 px-3 py-2 text-[13px] font-medium",
              view === v ? "border-ink text-ink" : "border-transparent text-text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[280px_minmax(0,1fr)_380px]">
        <aside
          aria-label="Sections"
          className={cn(
            "min-h-0 flex-col border-e border-border bg-surface",
            view === "sections" ? "flex" : "hidden xl:flex",
          )}
        >
          <SectionList
            sections={sections}
            selectedId={selectedId}
            problems={{ ...problems, ...publishProblems }}
            readOnly={readOnly}
            onSelect={(sid) => select(sid, "list")}
            onReorder={setSections}
            onMove={moveSection}
            onDuplicate={duplicateSection}
            onToggleHidden={(sid) => replace(sid, (s) => ({ ...s, hidden: !s.hidden }))}
            onRemove={removeSection}
            onAdd={() => setPickerOpen(true)}
          />
        </aside>
        <section
          aria-label="Preview"
          className={cn("min-h-0", view === "preview" ? "block" : "hidden xl:block")}
        >
          <PreviewFrame
            ref={preview}
            src={previewSrc}
            device={device}
            selectedId={selectedId}
            onSelect={(sid) => select(sid, "preview")}
          />
        </section>
        <aside
          aria-label="Section settings"
          className={cn(
            "min-h-0 flex-col overflow-y-auto border-s border-border bg-surface",
            view === "settings" ? "flex" : "hidden xl:flex",
          )}
        >
          {selected && isSectionType(selected.type) ? (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "content" | "style")}
              className="p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[14px] font-semibold text-ink">
                  {sectionCatalog[selected.type].label}
                  {selected.hidden && (
                    <span className="ms-2 text-[12px] font-normal text-text-muted">(hidden)</span>
                  )}
                </h2>
                <TabsList>
                  <TabsTrigger value="content">Content</TabsTrigger>
                  <TabsTrigger value="style">Style</TabsTrigger>
                </TabsList>
              </div>
              <fieldset disabled={readOnly} className="mt-3 min-w-0">
                <TabsContent value="content">
                  <SectionForm
                    key={selected.id}
                    type={selected.type}
                    props={selected.props}
                    onChange={(patch) =>
                      replace(selected.id, (s) => ({ ...s, props: { ...s.props, ...patch } }))
                    }
                    errorFor={errorFor}
                    ctx={ctx}
                  />
                </TabsContent>
                <TabsContent value="style">
                  <StyleFields
                    value={(selected.style ?? {}) as Partial<SectionStyle>}
                    onChange={(patch) =>
                      replace(selected.id, (s) => ({ ...s, style: { ...s.style, ...patch } }))
                    }
                    errorFor={errorFor}
                  />
                </TabsContent>
              </fieldset>
            </Tabs>
          ) : (
            <p className="p-6 text-center text-[13px] text-text-muted">
              {sections.length
                ? "Choose a section in the list or click it in the preview."
                : "Add a section to start."}
            </p>
          )}
        </aside>
      </div>

      <SectionPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={addSection}
        where={
          selected && isSectionType(selected.type)
            ? `after “${sectionCatalog[selected.type].label}”`
            : "at the end"
        }
      />
      <PageSettingsSheet
        open={panel === "settings"}
        onOpenChange={(open) => setPanel(open ? "settings" : null)}
        initial={{
          title: meta.title,
          slug: meta.slug,
          template: meta.template,
          seoTitle: meta.seoTitle,
          seoDescription: meta.seoDescription,
          ogImageId: meta.ogImageId,
          canonicalUrl: meta.canonicalUrl,
          noindex: meta.noindex,
          hideChat: meta.hideChat,
        }}
        isHome={meta.isHome}
        published={published}
        siteName={siteName}
        fallbackDescription=""
        onSave={saveSettings}
        readOnly={readOnly}
        aiSuggest={
          aiHelpers
            ? () => aiSuggestSeo({ kind: "page", title: meta.title, text: sectionsText(sections) })
            : undefined
        }
      />
      <RevisionsSheet
        open={panel === "revisions"}
        onOpenChange={(open) => setPanel(open ? "revisions" : null)}
        revisions={data.revisions}
        current={sections}
        currentTitle={meta.title}
        onRestore={restore}
        readOnly={readOnly}
      />
      <Dialog open={link !== null} onOpenChange={(open) => !open && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview link</DialogTitle>
            <DialogDescription>
              Anyone with this link sees the draft, without signing in. It works until{" "}
              {link ? longFormat.format(new Date(link.expiresAt)) : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              readOnly
              value={link?.url ?? ""}
              aria-label="Preview link"
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link?.url ?? "");
                  toast.success("Link copied");
                } catch {
                  toast.error("Could not copy the link");
                }
              }}
            >
              <CopyIcon /> Copy
            </Button>
          </div>
          <DialogFooter>
            <Button asChild variant="outline">
              <a href={link?.url} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon /> Open
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm === "discard"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Discard the unpublished changes?"
        description="The sections go back to the published version. This cannot be undone, but older versions stay in Revisions."
        confirmLabel="Discard changes"
        destructive
        onConfirm={discard}
      />
      <ConfirmDialog
        open={confirm === "unpublish"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Take this page off the site?"
        description="Visitors get the “page not found” page until you publish it again. Menu links to it stop working."
        confirmLabel="Unpublish"
        destructive
        onConfirm={unpublish}
      />
      <ConfirmDialog
        open={guard.pending !== null}
        onOpenChange={(open) => !open && guard.cancel()}
        title="Leave without saving?"
        description="The last changes are not saved yet."
        confirmLabel="Leave"
        destructive
        onConfirm={guard.leave}
      />
    </div>
  );
}

function SaveIndicator({
  state,
  dirty,
  readOnly,
}: {
  state: SaveState;
  dirty: boolean;
  readOnly: boolean;
}) {
  if (readOnly) return null;
  const text =
    state.kind === "saving"
      ? "Saving…"
      : state.kind === "error"
        ? "Not saved"
        : state.kind === "conflict"
          ? "Changed elsewhere"
          : dirty
            ? "Unsaved changes"
            : state.kind === "saved"
              ? `Draft saved ${timeFormat.format(new Date(state.at))}`
              : "";
  if (!text) return null;
  return (
    <span
      role="status"
      title={state.kind === "error" ? state.message : undefined}
      className={cn(
        "hidden text-[12px] whitespace-nowrap lg:inline",
        state.kind === "error" || state.kind === "conflict" ? "text-danger" : "text-text-muted",
      )}
    >
      {text}
    </span>
  );
}

function SchedulePopover({
  publishAt,
  canSchedule,
  onSchedule,
}: {
  publishAt: string | null;
  canSchedule: boolean;
  onSchedule: (at: string | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(toLocalInput(publishAt));
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(toLocalInput(publishAt));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={!canSchedule && !publishAt}>
          <CalendarClockIcon />{" "}
          <span className="hidden sm:inline">
            {publishAt ? longFormat.format(new Date(publishAt)) : "Schedule"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await onSchedule(new Date(value).toISOString());
            setBusy(false);
            if (ok) setOpen(false);
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink">
            Publish on
            <Input
              type="datetime-local"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <p className="text-[12px] text-text-muted">
            In your time zone ({zone}). The page, or its changes, go live then.
          </p>
          <div className="flex justify-end gap-2">
            {publishAt && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await onSchedule(null);
                  setBusy(false);
                  if (ok) setOpen(false);
                }}
              >
                Cancel schedule
              </Button>
            )}
            <Button type="submit" size="sm" disabled={busy || !value}>
              {publishAt ? "Change" : "Schedule"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
