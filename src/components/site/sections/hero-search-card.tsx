"use client";

import { SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "cn";
import { LocationSearch } from "@/components/site/search/location-search";
import { parseSearch, searchHref } from "@/features/search/params";
import { sectionsText as t } from "@/lib/i18n/dictionaries/home";
import { compactAmount } from "@/lib/currency-display";

type Tab = "buy" | "rent" | "off_plan";

const routes: Record<Tab, string> = { buy: "/buy", rent: "/rent", off_plan: "/off-plan" };

/**
 * Hero search card (06 §3): tabs Buy / Rent / Off-plan, place, type, budget and beds. A plain
 * GET form, so it works before JavaScript loads; with it, the URL is the canonical search URL.
 */
export function HeroSearchCard({
  tabs,
  defaultTab,
  types,
  budgets,
  currency,
}: {
  tabs: Tab[];
  defaultTab: Tab;
  types: Array<{ slug: string; name: string }>;
  /** Steps in minor units of the base currency. */
  budgets: { sale: number[]; rent: number[] };
  currency: { code: string; decimals: number };
}) {
  const id = useId();
  const [tab, setTab] = useState<Tab>(tabs.includes(defaultTab) ? defaultTab : tabs[0]!);
  const [places, setPlaces] = useState<Array<{ value: string; label: string }>>([]);
  const steps = tab === "rent" ? budgets.rent : budgets.sale;
  const scale = 10 ** currency.decimals;

  return (
    <form
      action={routes[tab]}
      method="get"
      role="search"
      aria-label={t.search.submit}
      className="@container rounded-[20px] bg-surface p-3 shadow-soft md:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const filters = parseSearch(
          {
            loc: places.map((p) => p.value),
            type: String(data.get("type") ?? ""),
            max: String(data.get("max") ?? ""),
            beds: String(data.get("beds") ?? ""),
          },
          {
            purpose: tab === "rent" ? "rent" : "sale",
            ...(tab === "off_plan" ? { completion: "off_plan" as const } : {}),
          },
        );
        window.location.assign(searchHref(filters));
      }}
    >
      {tabs.length > 1 && (
        <div role="tablist" aria-label={t.search.submit} className="mb-3 flex gap-1">
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                "rounded-full px-4 py-1.5 text-[14px] font-semibold transition-colors",
                tab === k ? "bg-ink text-surface" : "text-text-muted hover:text-ink",
              )}
            >
              {t.search.tabs[k]}
            </button>
          ))}
        </div>
      )}
      {/* Sized by the card, not the screen: in a half-width hero the place gets its own row. */}
      <div className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] @3xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
        <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border px-3 py-2 @md:col-span-full @3xl:col-span-1">
          <span className="text-[12px] font-semibold text-text-muted">{t.search.location}</span>
          <LocationSearch
            selected={places}
            onAdd={(value, label) =>
              setPlaces((list) =>
                list.some((p) => p.value === value) ? list : [...list, { value, label }],
              )
            }
            onRemove={(value) => setPlaces((list) => list.filter((p) => p.value !== value))}
          />
        </div>
        <label className="flex min-w-0 flex-col gap-1 rounded-xl border border-border px-3 py-2">
          <span className="text-[12px] font-semibold text-text-muted">{t.search.type}</span>
          <select
            name="type"
            defaultValue=""
            className="w-full min-w-0 bg-transparent text-[15px] text-ink outline-none"
          >
            <option value="">{t.search.anyType}</option>
            {types.map((ty) => (
              <option key={ty.slug} value={ty.slug}>
                {ty.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 rounded-xl border border-border px-3 py-2">
          <span className="text-[12px] font-semibold text-text-muted">{t.search.budget}</span>
          <select
            key={tab}
            name="max"
            defaultValue=""
            className="w-full min-w-0 bg-transparent text-[15px] text-ink outline-none"
          >
            <option value="">{t.search.anyBudget}</option>
            {steps.map((v) => (
              <option key={v} value={v / scale}>
                {t.search.upTo} {currency.code} {compactAmount(v, currency.decimals)}
              </option>
            ))}
          </select>
        </label>
        <label
          htmlFor={`${id}-beds`}
          className="hidden min-w-0 flex-col gap-1 rounded-xl border border-border px-3 py-2 @md:flex"
        >
          <span className="text-[12px] font-semibold text-text-muted">{t.search.beds}</span>
          <select
            id={`${id}-beds`}
            name="beds"
            defaultValue=""
            className="w-full min-w-0 bg-transparent text-[15px] text-ink outline-none"
          >
            <option value="">{t.search.anyBeds}</option>
            <option value="studio">{t.search.studio}</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="5">5+</option>
          </select>
        </label>
        <button
          type="submit"
          className="flex items-center justify-center gap-2 rounded-[14px] bg-accent px-6 py-3 text-[15px] font-semibold text-on-accent transition-colors hover:bg-accent/90"
        >
          <SearchIcon className="size-4" aria-hidden />
          {t.search.submit}
        </button>
      </div>
    </form>
  );
}
