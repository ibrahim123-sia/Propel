"use client";

import { CalendarCheckIcon, MessageCircleIcon, PhoneIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LazyDialog } from "@/components/ui/lazy-dialog";
import type { InquiryKind } from "@/features/inquiries/schema";
import { property as t } from "@/lib/i18n/dictionaries/property";
import { BrochureButton } from "../brochure/brochure-button";
import { TrackedContactLink } from "../tracked-contact-link";

// The forms load when someone opens "Book a tour" or "Request a callback", not with the page.
const InquiryForm = dynamic(() => import("./inquiry-form").then((m) => m.InquiryForm), {
  ssr: false,
});
const BookingForm = dynamic(() => import("../viewings/booking-form").then((m) => m.BookingForm), {
  ssr: false,
});

export type ContactInfo = {
  propertyId: string;
  reference: string;
  /** wa.me link with the reference and page address already in the message, or null. */
  whatsappHref: string | null;
  phone: string | null;
  /** The brochure download (uploaded or generated, 11 §4) and whether it asks for an email. */
  brochureUrl: string | null;
  brochureGated?: boolean;
  title?: string;
  /** Who meets the visitor: the agent's first name, or the agency. */
  agentName: string;
};

const titles: Record<InquiryKind, string> = {
  inquiry: t.form.inquiryTitle,
  tour: t.form.tourTitle,
  callback: t.form.callbackTitle,
};

/** One dialog for "Book a tour" and "Request a callback" (the tour flow proper is Phase 6). */
export function useInquiryDialog(info: ContactInfo) {
  const [kind, setKind] = useState<InquiryKind | null>(null);
  const dialog = (
    <LazyDialog
      open={kind !== null}
      onOpenChange={(o) => !o && setKind(null)}
      title={kind ? titles[kind] : ""}
      description={info.reference}
    >
      {kind === "tour" && <BookingForm propertyId={info.propertyId} agentName={info.agentName} />}
      {kind && kind !== "tour" && (
        <InquiryForm
          key={kind}
          propertyId={info.propertyId}
          reference={info.reference}
          kind={kind}
          onDone={() => setKind(null)}
        />
      )}
    </LazyDialog>
  );
  return { open: setKind, dialog };
}

/** Buttons in the sticky contact card (06 §5): tour, WhatsApp, call, callback, brochure. */
export function ContactActions({ info }: { info: ContactInfo }) {
  const { open, dialog } = useInquiryDialog(info);
  const [showNumber, setShowNumber] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Button size="md" onClick={() => open("tour")}>
        <CalendarCheckIcon aria-hidden /> {t.contact.tour}
      </Button>
      {info.whatsappHref && (
        <Button asChild variant="outline-site" size="md">
          <TrackedContactLink
            kind="whatsapp"
            refLabel={info.reference}
            entityType="property"
            entityId={info.propertyId}
            href={info.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircleIcon aria-hidden /> {t.contact.whatsapp}
          </TrackedContactLink>
        </Button>
      )}
      {info.phone &&
        (showNumber ? (
          <Button asChild variant="outline-site" size="md">
            <TrackedContactLink
              kind="call"
              entityType="property"
              entityId={info.propertyId}
              href={`tel:${info.phone}`}
            >
              <PhoneIcon aria-hidden /> {info.phone}
            </TrackedContactLink>
          </Button>
        ) : (
          <Button variant="outline-site" size="md" onClick={() => setShowNumber(true)}>
            <PhoneIcon aria-hidden /> {t.contact.call} · {t.contact.showNumber}
          </Button>
        ))}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[14px]">
        <button
          type="button"
          onClick={() => open("callback")}
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          {t.contact.callback}
        </button>
        {info.brochureUrl && (
          <BrochureButton
            kind="property"
            id={info.propertyId}
            href={info.brochureUrl}
            gated={Boolean(info.brochureGated)}
            label={t.contact.brochure}
            subject={info.title ? `${info.reference} · ${info.title}` : info.reference}
            className="inline-flex items-center gap-1 font-semibold text-ink underline-offset-4 hover:underline"
          />
        )}
      </div>
      {dialog}
    </div>
  );
}

/** Phone bottom bar (02 §5 property page): Book a tour and WhatsApp, always in reach. */
export function ContactBottomBar({ info }: { info: ContactInfo }) {
  const { open, dialog } = useInquiryDialog(info);
  return (
    <div
      role="region"
      aria-label={t.contact.bottomBar}
      className="fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:hidden print:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <Button size="md" className="flex-1" onClick={() => open("tour")}>
        <CalendarCheckIcon aria-hidden /> {t.contact.tour}
      </Button>
      {info.whatsappHref ? (
        <Button asChild variant="outline-site" size="md" className="flex-1">
          <TrackedContactLink
            kind="whatsapp"
            refLabel={info.reference}
            entityType="property"
            entityId={info.propertyId}
            href={info.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircleIcon aria-hidden /> {t.contact.whatsapp}
          </TrackedContactLink>
        </Button>
      ) : info.phone ? (
        <Button asChild variant="outline-site" size="md" className="flex-1">
          <TrackedContactLink
            kind="call"
            entityType="property"
            entityId={info.propertyId}
            href={`tel:${info.phone}`}
          >
            <PhoneIcon aria-hidden /> {t.contact.call}
          </TrackedContactLink>
        </Button>
      ) : null}
      {dialog}
    </div>
  );
}
