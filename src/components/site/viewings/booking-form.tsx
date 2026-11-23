"use client";

import { CalendarPlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "cn";
import { FormAlert } from "@/components/auth/auth-card";
import { TextField } from "@/components/auth/text-field";
import { Turnstile, turnstileEnabled } from "@/components/forms/turnstile";
import { Button } from "@/components/ui/button";
import { bookViewingAction } from "@/features/viewings/actions";
import { format } from "@/lib/i18n";
import { viewings as t } from "@/lib/i18n/dictionaries/viewings";
import { useHydrated } from "@/lib/use-hydrated";
import { SlotPicker, visitorZone } from "./slot-picker";

type Errors = Partial<Record<"start" | "name" | "phone" | "email" | "notes" | "consent", string>>;

const longTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

/**
 * Book a tour (09 §5): in person or by video, a real free time with the listing's agent, then
 * name, phone and email. The server checks the time again when it books.
 */
export function BookingForm({
  propertyId,
  projectId,
  agentName,
}: {
  propertyId?: string;
  projectId?: string;
  agentName: string;
}) {
  const hydrated = useHydrated();
  const honeypotId = useId();
  const [type, setType] = useState<"in_person" | "video">("in_person");
  const [start, setStart] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [fields, setFields] = useState({ name: "", phone: "", email: "", notes: "", website: "" });
  const [consent, setConsent] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [booked, setBooked] = useState<{ token: string; start: string } | null>(null);
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  if (booked)
    return (
      <div className="flex flex-col gap-3">
        <FormAlert tone="success">
          {format(t.booking.booked, { when: longTime(booked.start) })}{" "}
          {format(t.booking.bookedNote, { agent: agentName })}
        </FormAlert>
        {booked.token && (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline-site" size="md">
              <a href={`/api/viewings/${booked.token}/google`} target="_blank" rel="noopener">
                <CalendarPlusIcon aria-hidden /> {t.booking.addToGoogle}
              </a>
            </Button>
            <Button asChild variant="outline-site" size="md">
              <a href={`/api/viewings/${booked.token}/ics`}>
                <CalendarPlusIcon aria-hidden /> {t.booking.addToCalendar}
              </a>
            </Button>
            <Button asChild variant="ghost" size="md">
              <a href={`/viewings/${booked.token}`}>{t.booking.manage}</a>
            </Button>
          </div>
        )}
      </div>
    );

  const submit = async () => {
    const found: Errors = {};
    if (!start) found.start = t.booking.pickTime;
    if (fields.name.trim().length < 2) found.name = "Enter your name";
    if (!fields.phone.trim()) found.phone = "Enter a number we can reach you on";
    if (!consent) found.consent = "Please agree so we can contact you.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    setSending(true);
    const res = await bookViewingAction({
      propertyId: propertyId ?? null,
      projectId: projectId ?? null,
      type,
      start: start!,
      name: fields.name,
      phone: fields.phone,
      email: fields.email,
      notes: fields.notes,
      timeZone: visitorZone(),
      consent: true,
      website: fields.website,
      captchaToken: captcha,
    });
    setSending(false);
    if (res.ok) return setBooked({ token: res.data.manageToken, start: start! });
    if (res.code === "SLOT_TAKEN") {
      setStart(null);
      setReload((n) => n + 1);
      return setFormError(t.booking.taken);
    }
    const byField: Errors = {};
    for (const [path, messages] of Object.entries(res.fieldErrors ?? {}))
      byField[path as keyof Errors] = messages[0];
    setErrors(byField);
    if (!res.fieldErrors) setFormError(res.error);
  };

  const chip = (active: boolean) =>
    cn(
      "flex-1 rounded-full border px-3.5 py-2 text-center text-[14px] font-semibold transition-colors",
      active
        ? "border-ink bg-ink text-surface"
        : "border-border bg-surface text-ink hover:border-ink/40",
    );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {formError && <FormAlert>{formError}</FormAlert>}
      <fieldset className="min-w-0">
        <legend className="mb-2 text-[14px] font-semibold text-ink">{t.booking.typeLabel}</legend>
        <div className="flex gap-2">
          {(["in_person", "video"] as const).map((k) => (
            <label key={k} className="flex flex-1">
              <input
                type="radio"
                name={`${honeypotId}-type`}
                className="peer sr-only"
                checked={type === k}
                onChange={() => setType(k)}
              />
              <span className={chip(type === k)}>
                {k === "video" ? t.booking.video : t.booking.inPerson}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <SlotPicker
        source={propertyId ? `property=${propertyId}` : `project=${projectId}`}
        value={start}
        onChange={setStart}
        reloadKey={reload}
        error={errors.start}
      />
      <TextField
        label={t.booking.name}
        autoComplete="name"
        size="default"
        value={fields.name}
        onChange={set("name")}
        error={errors.name}
      />
      <TextField
        label={t.booking.phone}
        type="tel"
        autoComplete="tel"
        size="default"
        value={fields.phone}
        onChange={set("phone")}
        error={errors.phone}
      />
      <TextField
        label={t.booking.email}
        type="email"
        autoComplete="email"
        size="default"
        value={fields.email}
        onChange={set("email")}
        error={errors.email}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] font-semibold text-ink">{t.booking.notes}</span>
        <textarea
          rows={2}
          className="rounded-input border border-input bg-surface px-3 py-2 text-[15px]"
          value={fields.notes}
          onChange={set("notes")}
        />
      </label>
      {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
      <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
        <label htmlFor={honeypotId}>Website</label>
        <input
          id={honeypotId}
          tabIndex={-1}
          autoComplete="off"
          value={fields.website}
          onChange={set("website")}
        />
      </div>
      <label className="flex items-start gap-2 text-[14px] text-text">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-[var(--color-accent)]"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {t.booking.consent}
      </label>
      {errors.consent && <p className="text-[13px] font-medium text-danger">{errors.consent}</p>}
      <Turnstile onToken={setCaptcha} action="viewing-booking" />
      <Button
        type="submit"
        size="md"
        disabled={!hydrated || sending || (turnstileEnabled && !captcha)}
      >
        {sending ? t.booking.sending : t.booking.submit}
      </Button>
    </form>
  );
}
