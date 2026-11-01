"use client";

import type { ReactNode, RefObject } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { SiteLink } from "@/features/menus/schema";
import { site } from "@/lib/i18n";
import { MenuLink } from "./menu-link";

/** The phone menu's sheet; `MobileMenu` loads it the first time the menu opens. */
export function MobileMenuSheet({
  open,
  onOpenChange,
  opener,
  nav,
  agencyName,
  button,
  extras,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The menu button: focus goes back to it on close (it is not a Radix trigger). */
  opener: RefObject<HTMLButtonElement | null>;
  nav: SiteLink[];
  agencyName: string;
  button?: { label: string; href: string } | null;
  extras?: ReactNode;
}) {
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-none bg-bg sm:max-w-sm"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-display text-xl font-normal">{agencyName}</SheetTitle>
        </SheetHeader>
        {nav.length > 0 && (
          <nav aria-label={site.a11y.mainNavigation} className="px-4">
            <ul className="flex flex-col">
              {nav.map((item, i) => (
                <li key={`${i}-${item.href}`} className="border-b border-border">
                  <MenuLink link={item} onClick={close} className="block py-4 text-lg text-ink" />
                  {item.children.length > 0 && (
                    <ul className="flex flex-col ps-4 pb-3">
                      {item.children.map((c, j) => (
                        <li key={`${j}-${c.href}`}>
                          <MenuLink
                            link={c}
                            onClick={close}
                            className="block py-2 text-[16px] text-text-muted hover:text-ink"
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="flex flex-col gap-6 px-4 pt-6">
          {button && (
            <a
              href={button.href}
              onClick={close}
              className="inline-flex h-12 items-center justify-center rounded-button bg-primary px-5 text-[15px] font-semibold text-primary-foreground"
            >
              {button.label}
            </a>
          )}
          {extras}
        </div>
      </SheetContent>
    </Sheet>
  );
}
