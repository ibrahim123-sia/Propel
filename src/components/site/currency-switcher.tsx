"use client";

import { ChevronDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { notify } from "./site-toaster";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { setCurrency } from "@/features/site/currency-actions";
import { pages } from "@/lib/i18n";
import { useLoadOnDemand } from "@/lib/use-load-on-demand";

// The dropdown (Radix menu and positioning) loads on the first click, not with every page.
const loadDropdown = () => import("./currency-dropdown").then((m) => m.CurrencyDropdown);

export type CurrencyOption = { code: string; symbol: string; example: boolean };

/**
 * Currency switcher (06 §2): changes the display currency site-wide. A dropdown in the
 * header, a list in the phone menu. Converted prices show "≈" with the listed price.
 */
export function CurrencySwitcher({
  current,
  options,
  variant = "menu",
}: {
  current: string;
  options: CurrencyOption[];
  variant?: "menu" | "list";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState(current);
  const name = useId();
  const [Dropdown, loadMenu] = useLoadOnDemand(loadDropdown);
  const t = pages.currency;

  const choose = (code: string) => {
    if (code === chosen) return;
    const previous = chosen;
    setChosen(code);
    startTransition(async () => {
      const res = await setCurrency({ code });
      if (!res.ok) {
        setChosen(previous);
        notify.error(res.error);
        return;
      }
      router.refresh();
    });
  };

  if (options.length < 2) return null;
  const label = (o: CurrencyOption) => `${o.code}${o.example ? ` · ${t.example}` : ""}`;

  if (variant === "list") {
    return (
      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="mb-2 text-eyebrow text-text-muted">{t.choose}</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <label
              key={o.code}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1.5 text-[14px] font-medium has-[:focus-visible]:ring-2",
                o.code === chosen
                  ? "border-ink bg-ink text-surface"
                  : "border-border bg-surface text-ink",
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.code}
                checked={o.code === chosen}
                onChange={() => choose(o.code)}
                className="sr-only"
              />
              {label(o)}
            </label>
          ))}
        </div>
        <p className="text-[12.5px] text-text-muted">{t.note}</p>
      </fieldset>
    );
  }

  const trigger = (
    <Button
      variant="ghost"
      className="gap-1 px-2.5 text-[15px] font-semibold text-ink"
      aria-label={`${t.label}: ${chosen}`}
      aria-haspopup="menu"
      disabled={pending}
      onClick={Dropdown ? undefined : loadMenu}
    >
      {chosen}
      <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
    </Button>
  );
  if (!Dropdown) return trigger;
  return (
    <Dropdown
      trigger={trigger}
      chosen={chosen}
      options={options.map((o) => ({ code: o.code, label: label(o) }))}
      onChoose={choose}
    />
  );
}
