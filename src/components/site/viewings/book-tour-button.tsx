"use client";

import { CalendarCheckIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LazyDialog } from "@/components/ui/lazy-dialog";
import { viewings as t } from "@/lib/i18n/dictionaries/viewings";
import { takeTourParam } from "../property/contact-actions";

// The booking flow loads when someone opens it, not with the page.
const BookingForm = dynamic(() => import("./booking-form").then((m) => m.BookingForm), {
  ssr: false,
});

/** "Book a tour" on a project page (09 §5): the agency's free times for the project. */
export function BookTourButton({
  projectId,
  subject,
  agentName,
}: {
  projectId: string;
  subject: string;
  agentName: string;
}) {
  const [open, setOpen] = useState(false);
  // "Book tour" on a chat card links here with ?tour=1.
  useEffect(() => {
    // Not cancelled on cleanup: the parameter is read once (Strict Mode runs effects twice).
    if (takeTourParam()) requestAnimationFrame(() => setOpen(true));
  }, []);
  return (
    <>
      <Button size="md" className="w-full" onClick={() => setOpen(true)}>
        <CalendarCheckIcon aria-hidden /> {t.booking.title}
      </Button>
      <LazyDialog open={open} onOpenChange={setOpen} title={t.booking.title} description={subject}>
        {open && <BookingForm projectId={projectId} agentName={agentName} />}
      </LazyDialog>
    </>
  );
}
