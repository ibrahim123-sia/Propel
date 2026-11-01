"use client";

import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pages } from "@/lib/i18n";

/** The header currency menu; loaded on the first click, so it opens at once. */
export function CurrencyDropdown({
  trigger,
  chosen,
  options,
  onChoose,
}: {
  trigger: ReactElement;
  chosen: string;
  options: Array<{ code: string; label: string }>;
  onChoose: (code: string) => void;
}) {
  const t = pages.currency;
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>{t.choose}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={chosen} onValueChange={onChoose}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.code} value={o.code}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pt-1 pb-1.5 text-[12px] text-text-muted">{t.note}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
