"use client";

import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { compactMoney, pluralType, type SearchLabels } from "@/features/search/labels";
import type { SearchOptions } from "@/features/search/page-data";
import { commuteMinutes, searchQuery, type SearchFilters } from "@/features/search/params";
import { displayPrice, type Rates } from "@/lib/currency-display";
import { format } from "@/lib/i18n";
import { search as t } from "@/lib/i18n/dictionaries/search";
import type { CurrencyFormat } from "@/lib/money";
import { areaUnitLabels, type AreaUnit } from "@/lib/units";

export type FilterContext = {
  options: SearchOptions;
  labels: SearchLabels;
  currency: CurrencyFormat;
  visitor: { code: string; rates: Rates };
  areaUnit: AreaUnit;
};

const pill =
  "inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-[14px] font-medium text-ink hover:border-ink/30 aria-expanded:border-ink/40";

/** Number box for prices and sizes: empty means "no limit". */
function NumberBox({
  label,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  hint?: string | null;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-[12.5px] font-semibold text-ink">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-ink/40">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Math.max(0, Number(e.target.value)))
          }
          className="h-10 w-full min-w-0 bg-transparent text-[15px] text-ink tabular outline-none"
        />
        {suffix && <span className="shrink-0 text-[13px] text-text-muted">{suffix}</span>}
      </div>
      {hint && <p className="text-[12px] text-text-muted">{hint}</p>}
    </div>
  );
}

/** The visitor's currency under a base-currency price box (06 §4.2 "slider shows visitor currency"). */
function visitorHint(major: number | null, ctx: FilterContext): string | null {
  if (major == null || ctx.visitor.code === ctx.currency.code) return null;
  const d = displayPrice(
    Math.round(major * 10 ** ctx.currency.decimals),
    ctx.currency.code,
    ctx.visitor.code,
    ctx.visitor.rates,
  );
  return d.approximate ? d.text : null;
}

export function PriceFields({
  f,
  set,
  ctx,
}: {
  f: SearchFilters;
  set: (patch: Partial<SearchFilters>) => void;
  ctx: FilterContext;
}) {
  return (
    <div className="flex gap-3">
      <NumberBox
        label={t.filters.priceMin}
        value={f.min}
        suffix={ctx.currency.code}
        hint={visitorHint(f.min, ctx)}
        onChange={(min) => set({ min })}
      />
      <NumberBox
        label={t.filters.priceMax}
        value={f.max}
        suffix={ctx.currency.code}
        hint={visitorHint(f.max, ctx)}
        onChange={(max) => set({ max })}
      />
    </div>
  );
}

const bedChoices = [0, 1, 2, 3, 4, 5];

export function BedsField({
  f,
  set,
}: {
  f: SearchFilters;
  set: (patch: Partial<SearchFilters>) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.beds}</legend>
      <div className="flex flex-wrap gap-2">
        {bedChoices.map((b) => {
          const on = f.beds.includes(b);
          return (
            <button
              key={b}
              type="button"
              aria-pressed={on}
              onClick={() =>
                set({
                  beds: on ? f.beds.filter((x) => x !== b) : [...f.beds, b].sort((x, y) => x - y),
                })
              }
              className={cn(
                "h-10 min-w-12 rounded-full border px-3 text-[14px] font-medium",
                on
                  ? "border-ink bg-ink text-surface"
                  : "border-border bg-surface text-ink hover:border-ink/30",
              )}
            >
              {b === 0 ? t.filters.studio : b === 5 ? format(t.filters.bedsPlus, { count: 5 }) : b}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function BathsField({
  f,
  set,
}: {
  f: SearchFilters;
  set: (patch: Partial<SearchFilters>) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.baths}</legend>
      <div className="flex flex-wrap gap-2">
        {[null, 1, 2, 3, 4].map((b) => {
          const on = f.baths === b;
          return (
            <button
              key={b ?? "any"}
              type="button"
              aria-pressed={on}
              onClick={() => set({ baths: b })}
              className={cn(
                "h-10 min-w-12 rounded-full border px-3 text-[14px] font-medium",
                on
                  ? "border-ink bg-ink text-surface"
                  : "border-border bg-surface text-ink hover:border-ink/30",
              )}
            >
              {b === null ? t.filters.bathsAny : format(t.filters.bathsPlus, { count: b })}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function TypesField({
  f,
  set,
  ctx,
}: {
  f: SearchFilters;
  set: (patch: Partial<SearchFilters>) => void;
  ctx: FilterContext;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.type}</legend>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {ctx.options.types.map((type) => {
          const on = f.type.includes(type.slug);
          return (
            <label key={type.slug} className="flex items-center gap-2 text-[14px] text-ink">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-ink)]"
                checked={on}
                onChange={() =>
                  set({ type: on ? f.type.filter((s) => s !== type.slug) : [...f.type, type.slug] })
                }
              />
              {pluralType(type.name)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Choice<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12.5px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value === null ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value ?? "") === raw);
          onChange((match ? match.value : null) as T);
        }}
        className="h-10 rounded-xl border border-border bg-surface px-3 text-[15px] text-ink"
      >
        {options.map((o) => (
          <option key={String(o.value ?? "")} value={o.value === null ? "" : String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function handoverOptions(year: number): Array<{ value: string | null; label: string }> {
  const out: Array<{ value: string | null; label: string }> = [
    { value: null, label: t.filters.anyHandover },
  ];
  for (let y = year; y <= year + 5; y++) {
    for (const q of [1, 2, 3, 4]) out.push({ value: `${y}-Q${q}`, label: `Q${q} ${y}` });
    out.push({ value: String(y), label: String(y) });
  }
  return out;
}

/** Every filter (06 §4.2), for the sheet on phones and "More filters" on desktop. */
/** Commute time (11 §9): one of the agency's places, by car or on foot, within N minutes. */
function CommuteField({
  value,
  onChange,
  places,
}: {
  value: SearchFilters["commute"];
  onChange: (commute: SearchFilters["commute"]) => void;
  places: FilterContext["options"]["places"];
}) {
  const placeId = useId();
  const types = [...new Set(places.map((p) => p.typeName))];
  const c = t.commute;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[14px] font-semibold text-ink">{c.title}</legend>
      <div className="flex flex-col gap-1">
        <label htmlFor={placeId} className="text-[12.5px] font-semibold text-ink">
          {c.place}
        </label>
        <select
          id={placeId}
          value={value?.poi ?? ""}
          onChange={(e) =>
            onChange(
              e.target.value
                ? {
                    poi: e.target.value,
                    mode: value?.mode ?? "drive",
                    minutes: value?.minutes ?? 20,
                  }
                : null,
            )
          }
          className="h-10 rounded-xl border border-border bg-surface px-3 text-[15px] text-ink"
        >
          <option value="">{c.anyPlace}</option>
          {types.map((type) => (
            <optgroup key={type} label={type}>
              {places
                .filter((p) => p.typeName === type)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {value && (
        <div className="grid grid-cols-2 gap-3">
          <Choice
            label={c.mode}
            value={value.mode}
            onChange={(mode) => onChange({ ...value, mode })}
            options={[
              { value: "drive" as const, label: c.byCar },
              { value: "walk" as const, label: c.onFoot },
            ]}
          />
          <Choice
            label={c.within}
            value={value.minutes}
            onChange={(minutes) => onChange({ ...value, minutes })}
            options={commuteMinutes.map((m) => ({
              value: m as number,
              label: format(c.minutes, { minutes: m }),
            }))}
          />
        </div>
      )}
      {value && <p className="text-[12.5px] text-text-muted">{c.note}</p>}
    </fieldset>
  );
}

export function AllFilters({
  f,
  set,
  ctx,
}: {
  f: SearchFilters;
  set: (patch: Partial<SearchFilters>) => void;
  ctx: FilterContext;
}) {
  const unit = areaUnitLabels[ctx.areaUnit];
  const keywordId = useId();
  const offPlan = f.completion === "off_plan";
  const groups = [...new Set(ctx.options.facilities.map((x) => x.group))];
  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="mb-2 text-[12.5px] font-semibold text-ink">{t.purpose.label}</legend>
        <div className="inline-flex rounded-full border border-border bg-surface-soft p-1">
          {(
            [
              {
                label: t.purpose.sale,
                on: f.purpose === "sale" && !offPlan,
                patch: { purpose: "sale", completion: null },
              },
              {
                label: t.purpose.rent,
                on: f.purpose === "rent",
                patch: { purpose: "rent", completion: null, handover: null, plan: null },
              },
              {
                label: t.purpose.offPlan,
                on: f.purpose === "sale" && offPlan,
                patch: { purpose: "sale", completion: "off_plan", cheques: null },
              },
            ] as const
          ).map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={o.on}
              onClick={() => set(o.patch as Partial<SearchFilters>)}
              className={cn(
                "rounded-full px-4 py-1.5 text-[14px] font-medium",
                o.on ? "bg-ink text-surface" : "text-ink hover:bg-surface-muted",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>
      {f.purpose === "sale" && (
        <Choice
          label={t.completion.label}
          value={f.completion}
          onChange={(completion) => set({ completion })}
          options={[
            { value: null, label: t.completion.any },
            { value: "ready", label: t.completion.ready },
            { value: "off_plan", label: t.completion.offPlan },
          ]}
        />
      )}
      {ctx.options.types.length > 0 && <TypesField f={f} set={set} ctx={ctx} />}
      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.price}</p>
        <PriceFields f={f} set={set} ctx={ctx} />
      </div>
      <BedsField f={f} set={set} />
      <BathsField f={f} set={set} />
      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.size}</p>
        <div className="flex gap-3">
          <NumberBox
            label={t.filters.sizeMin}
            value={f.smin}
            suffix={unit}
            onChange={(smin) => set({ smin })}
          />
          <NumberBox
            label={t.filters.sizeMax}
            value={f.smax}
            suffix={unit}
            onChange={(smax) => set({ smax })}
          />
        </div>
      </div>
      {ctx.options.furnishing.length > 0 && (
        <Choice
          label={t.filters.furnishing}
          value={f.furn}
          onChange={(furn) => set({ furn })}
          options={[
            { value: null, label: t.filters.anyFurnishing },
            ...ctx.options.furnishing.map((o) => ({ value: o, label: o })),
          ]}
        />
      )}
      {ctx.options.facilities.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-[12.5px] font-semibold text-ink">
            {t.filters.facilities}
          </legend>
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <div key={g} className="grid grid-cols-2 gap-x-4 gap-y-2">
                {ctx.options.facilities
                  .filter((x) => x.group === g)
                  .map((fac) => {
                    const on = f.fac.includes(fac.id);
                    return (
                      <label key={fac.id} className="flex items-center gap-2 text-[14px] text-ink">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--color-ink)]"
                          checked={on}
                          onChange={() =>
                            set({
                              fac: on ? f.fac.filter((x) => x !== fac.id) : [...f.fac, fac.id],
                            })
                          }
                        />
                        {fac.name}
                      </label>
                    );
                  })}
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 text-[12.5px] font-semibold text-ink">{t.filters.badges}</legend>
        <div className="flex flex-col gap-2">
          {(
            [
              ["verified", t.filters.verified],
              ["price_reduced", t.filters.priceReduced],
              ["new_listing", t.filters.newListing],
            ] as const
          ).map(([value, label]) => {
            const on = f.badge.includes(value);
            return (
              <label key={value} className="flex items-center gap-2 text-[14px] text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-ink)]"
                  checked={on}
                  onChange={() =>
                    set({ badge: on ? f.badge.filter((x) => x !== value) : [...f.badge, value] })
                  }
                />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>
      {f.purpose === "sale" && f.completion !== "ready" && (
        <>
          <Choice
            label={t.filters.handover}
            value={f.handover}
            onChange={(handover) => set({ handover })}
            options={handoverOptions(ctx.options.year)}
          />
          <Choice
            label={t.filters.plan}
            value={f.plan}
            onChange={(plan) => set({ plan })}
            options={[
              { value: null, label: t.filters.anyPlan },
              { value: "any", label: t.filters.planAny },
              { value: "post_handover", label: t.filters.planPostHandover },
            ]}
          />
        </>
      )}
      {f.purpose === "rent" && ctx.options.rentPaymentOptions.length > 0 && (
        <Choice
          label={t.filters.cheques}
          value={f.cheques}
          onChange={(cheques) => set({ cheques })}
          options={[
            { value: null, label: t.filters.anyCheques },
            ...ctx.options.rentPaymentOptions.map((n) => ({
              value: n,
              label: n === 1 ? t.filters.chequesOne : format(t.filters.chequesN, { count: n }),
            })),
          ]}
        />
      )}
      {ctx.options.places.length > 0 && (
        <CommuteField
          value={f.commute}
          onChange={(commute) => set({ commute })}
          places={ctx.options.places}
        />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={keywordId} className="text-[12.5px] font-semibold text-ink">
          {t.filters.keyword}
        </label>
        <input
          id={keywordId}
          value={f.q}
          maxLength={100}
          placeholder={t.filters.keywordPlaceholder}
          onChange={(e) => set({ q: e.target.value })}
          className="h-10 rounded-xl border border-border bg-surface px-3 text-[15px] text-ink outline-none focus:border-ink/40"
        />
      </div>
    </div>
  );
}

/** "Show N homes": counts the draft before it is applied (06 §4.1). */
export function useDraftCount(draft: SearchFilters, enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  const query = searchQuery({ ...draft, page: 1, sort: "newest" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/count?${query}`, { signal: controller.signal });
        const data = (await res.json()) as { count?: number };
        setCount(typeof data.count === "number" ? data.count : null);
      } catch {
        /* aborted */
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled]);
  return enabled ? count : null;
}

export function showLabel(count: number | null): string {
  if (count === null) return t.filters.counting;
  if (count === 0) return t.filters.showNone;
  if (count === 1) return t.filters.showOne;
  return format(t.filters.show, { count: count.toLocaleString("en") });
}

/** Full filter sheet: right side on desktop, full screen on phones, sticky "Show N homes". */
export function FilterSheet({
  filters,
  ctx,
  onApply,
  trigger,
  activeCount,
}: {
  filters: SearchFilters;
  ctx: FilterContext;
  onApply: (f: SearchFilters) => void;
  trigger: (props: { onClick: () => void; activeCount: number }) => ReactNode;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const count = useDraftCount(draft, open);
  const set = (patch: Partial<SearchFilters>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <>
      {trigger({
        onClick: () => {
          setDraft(filters);
          setOpen(true);
        },
        activeCount,
      })}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="h-[100dvh] w-full gap-0 p-0 sm:max-w-md"
          aria-describedby={undefined}
        >
          <SheetHeader className="border-b border-border px-5 py-4">
            <SheetTitle className="text-[17px]">{t.filters.title}</SheetTitle>
            <SheetDescription className="sr-only">{t.filters.title}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <AllFilters f={draft} set={set} ctx={ctx} />
          </div>
          <SheetFooter className="sticky bottom-0 flex-row items-center justify-between gap-3 border-t border-border bg-surface px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  type: [],
                  min: null,
                  max: null,
                  beds: [],
                  baths: null,
                  smin: null,
                  smax: null,
                  furn: null,
                  fac: [],
                  badge: [],
                  handover: null,
                  plan: null,
                  cheques: null,
                  commute: null,
                  q: "",
                }))
              }
            >
              {t.filters.clear}
            </Button>
            <Button
              type="button"
              size="lg"
              className="flex-1"
              disabled={count === 0}
              onClick={() => {
                setOpen(false);
                onApply({ ...draft, page: 1 });
              }}
            >
              {showLabel(count)}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** A filter in a popover on desktop; changes apply when it closes or on "Apply". */
export function FilterPopover({
  label,
  summary,
  filters,
  onApply,
  children,
  wide,
}: {
  label: string;
  /** What is chosen, shown on the button ("2–3 beds"), or null. */
  summary: string | null;
  filters: SearchFilters;
  onApply: (f: SearchFilters) => void;
  children: (draft: SearchFilters, set: (patch: Partial<SearchFilters>) => void) => ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const set = (patch: Partial<SearchFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const apply = () => {
    if (searchQuery(draft) !== searchQuery(filters)) onApply({ ...draft, page: 1 });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(filters);
        else apply();
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={cn(pill, summary && "border-ink/40 bg-surface-muted")}>
          {summary ?? label}
          <ChevronDownIcon className="size-4 text-text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("flex flex-col gap-4 p-4", wide ? "w-[26rem]" : "w-80")}
      >
        {children(draft, set)}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              apply();
              setOpen(false);
            }}
          >
            {t.filters.apply}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FiltersButton({
  onClick,
  activeCount,
  label,
}: {
  onClick: () => void;
  activeCount: number;
  label: string;
}) {
  return (
    <button type="button" onClick={onClick} className={pill}>
      <SlidersHorizontalIcon className="size-4" aria-hidden />
      {label}
      {activeCount > 0 && (
        <span className="ms-0.5 inline-flex size-5 items-center justify-center rounded-full bg-ink text-[11.5px] font-semibold text-surface">
          {activeCount}
        </span>
      )}
    </button>
  );
}

export { compactMoney };
