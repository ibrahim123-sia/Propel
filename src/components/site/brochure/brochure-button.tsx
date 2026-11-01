"use client";

import { DownloadIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, useSyncExternalStore } from "react";
import { LazyDialog } from "@/components/ui/lazy-dialog";
import type { BrochureKind } from "@/features/brochure/types";
import { brochure as t } from "@/lib/i18n/dictionaries/brochure";

// The gate's form loads when someone opens it, not with the page.
const GateForm = dynamic(() => import("./brochure-gate-form").then((m) => m.BrochureGateForm), {
  ssr: false,
});

// The address does not change while the page is open, so there is nothing to subscribe to.
const subscribe = () => () => {};
const askedInUrl = () => new URLSearchParams(window.location.search).get("brochure") === "1";

/**
 * "Download brochure" (11 §4) on property and project pages: a plain download, or, with the
 * email gate on (Settings -> Leads), a short form first. A link that lands here with
 * `?brochure=1` (the gate sends people back to the page) opens the form at once.
 */
export function BrochureButton({
  kind,
  id,
  href,
  gated,
  label,
  subject,
  className,
}: {
  kind: BrochureKind;
  id: string;
  href: string;
  gated: boolean;
  label: string;
  /** What the brochure is about (title or reference), for the dialog. */
  subject: string;
  className?: string;
}) {
  const asked = useSyncExternalStore(subscribe, askedInUrl, () => false);
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? (gated && asked);

  if (!gated)
    return (
      <a id="brochure" href={href} download className={className}>
        <DownloadIcon className="size-4" aria-hidden /> {label}
      </a>
    );
  return (
    <>
      <button
        id="brochure"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={className}
      >
        <DownloadIcon className="size-4" aria-hidden /> {label}
      </button>
      <LazyDialog open={open} onOpenChange={setOpen} title={t.gate.title} description={subject}>
        {open && <GateForm kind={kind} id={id} onClose={() => setOpen(false)} />}
      </LazyDialog>
    </>
  );
}
