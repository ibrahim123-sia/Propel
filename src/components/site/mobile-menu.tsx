"use client";

import { MenuIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { SiteLink } from "@/features/menus/schema";
import { site } from "@/lib/i18n";

// The sheet (Radix dialog, focus trap, scroll lock) loads when the menu first opens.
const MobileMenuSheet = dynamic(
  () => import("./mobile-menu-sheet").then((m) => m.MobileMenuSheet),
  { ssr: false },
);

/**
 * Phone menu: a full-screen sheet with the phone menu (or the header menu), dropdown links
 * listed under their parent, the primary button and `extras` (the currency switcher), 02 §5.
 */
export function MobileMenu({
  nav,
  agencyName,
  button,
  extras,
}: {
  nav: SiteLink[];
  agencyName: string;
  button?: { label: string; href: string } | null;
  extras?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (nav.length === 0 && !button && !extras) return null;
  return (
    <>
      <Button
        ref={opener}
        variant="ghost"
        size="icon-lg"
        className="lg:hidden"
        aria-label={site.a11y.openMenu}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
      >
        <MenuIcon className="size-6" />
      </Button>
      {used && (
        <MobileMenuSheet
          open={open}
          onOpenChange={setOpen}
          opener={opener}
          nav={nav}
          agencyName={agencyName}
          button={button}
          extras={extras}
        />
      )}
    </>
  );
}
