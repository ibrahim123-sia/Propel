"use client";

import { useId, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { FormAlert } from "@/components/auth/auth-card";
import { TextField } from "@/components/auth/text-field";
import { Turnstile, turnstileEnabled } from "@/components/forms/turnstile";
import { Button } from "@/components/ui/button";
import { sendPageForm } from "@/features/forms/actions";
import { checkPageForm } from "@/features/forms/check";
import type { PageFormInput, PageFormType } from "@/features/forms/schema";
import { cms } from "@/lib/i18n/dictionaries/cms";
import { useHydrated } from "@/lib/use-hydrated";

/** The server schema's checks without Zod in the browser (features/forms/check.ts). */
const resolver: Resolver<PageFormInput> = async (values) => {
  const found = checkPageForm(values);
  const keys = Object.keys(found) as Array<keyof PageFormInput>;
  if (keys.length === 0) return { values, errors: {} };
  return {
    values: {},
    errors: Object.fromEntries(keys.map((key) => [key, { type: "validate", message: found[key] }])),
  };
};

/**
 * A page builder form (08 §1 "Form", 06 §10): contact, callback, valuation, list your property
 * or newsletter. Checked here and again on the server, with a honeypot and Turnstile. The
 * success message says what happens next.
 */
export function PageForm({
  formType,
  pageId,
  buttonLabel,
  successMessage,
  propertyTypes,
}: {
  formType: PageFormType;
  pageId: string | null;
  buttonLabel?: string;
  successMessage?: string;
  /** For the valuation and list-your-property forms. */
  propertyTypes: string[];
}) {
  const t = cms.forms;
  const hydrated = useHydrated();
  const honeypotId = useId();
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const form = useForm<PageFormInput>({
    resolver,
    defaultValues: {
      formType,
      pageId,
      name: "",
      email: "",
      phone: "",
      message: "",
      preferredTime: "",
      purpose: null,
      area: "",
      propertyType: "",
      beds: "",
      expectedPrice: "",
      consent: false as unknown as true,
      website: "",
      captchaToken: null,
    },
  });
  const { register, handleSubmit, formState, setError } = form;
  const err = (name: keyof PageFormInput) => formState.errors[name]?.message as string | undefined;

  if (sent) return <FormAlert tone="success">{successMessage || t.success[formType]}</FormAlert>;

  const select =
    "h-11 w-full rounded-input border border-input bg-surface px-3 text-[15px] text-ink";
  const property = formType === "valuation" || formType === "list_property";
  return (
    <form
      noValidate
      className="relative flex flex-col gap-3"
      onSubmit={handleSubmit(async (values) => {
        setFormError(null);
        const res = await sendPageForm({ ...values, captchaToken: captcha });
        if (res.ok) {
          setSent(true);
          return;
        }
        for (const [path, messages] of Object.entries(res.fieldErrors ?? {}))
          setError(path as keyof PageFormInput, { message: messages[0] });
        if (!res.fieldErrors) setFormError(res.error);
      })}
    >
      {formError && <FormAlert>{formError}</FormAlert>}
      {formType !== "newsletter" && (
        <TextField
          label={t.name}
          autoComplete="name"
          size="default"
          error={err("name")}
          {...register("name")}
        />
      )}
      {formType !== "callback" && (
        <TextField
          label={t.email}
          type="email"
          autoComplete="email"
          size="default"
          error={err("email")}
          {...register("email")}
        />
      )}
      {formType !== "newsletter" && (
        <TextField
          label={t.phone}
          type="tel"
          autoComplete="tel"
          size="default"
          error={err("phone")}
          {...register("phone")}
        />
      )}
      {formType === "callback" && (
        <TextField
          label={t.preferredTime}
          size="default"
          error={err("preferredTime")}
          {...register("preferredTime")}
        />
      )}
      {formType === "list_property" && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[14px] font-semibold text-ink">{t.purpose}</legend>
          <div className="flex gap-4 text-[15px]">
            {(["sale", "rent"] as const).map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input
                  type="radio"
                  value={p}
                  className="size-4 accent-[var(--color-accent)]"
                  {...register("purpose")}
                />
                {t.purposes[p]}
              </label>
            ))}
          </div>
          {err("purpose") && (
            <span className="text-[13px] font-medium text-danger">{err("purpose")}</span>
          )}
        </fieldset>
      )}
      {property && (
        <>
          <TextField label={t.area} size="default" error={err("area")} {...register("area")} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[14px] font-semibold text-ink">{t.propertyType}</span>
              <select className={select} {...register("propertyType")}>
                <option value="">{t.any}</option>
                {propertyTypes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label={t.beds}
              inputMode="numeric"
              size="default"
              error={err("beds")}
              {...register("beds")}
            />
          </div>
          {formType === "list_property" && (
            <TextField
              label={t.expectedPrice}
              size="default"
              error={err("expectedPrice")}
              {...register("expectedPrice")}
            />
          )}
        </>
      )}
      {formType !== "newsletter" && formType !== "callback" && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-semibold text-ink">
            {formType === "contact" ? t.message : t.messageOptional}
          </span>
          <textarea
            rows={4}
            className="rounded-input border border-input bg-surface px-3 py-2 text-[15px]"
            aria-invalid={err("message") ? true : undefined}
            {...register("message")}
          />
          {err("message") && (
            <span className="text-[13px] font-medium text-danger">{err("message")}</span>
          )}
        </label>
      )}
      {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
      <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
        <label htmlFor={honeypotId}>Website</label>
        <input id={honeypotId} tabIndex={-1} autoComplete="off" {...register("website")} />
      </div>
      <label className="flex items-start gap-2 text-[14px] text-text">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-[var(--color-accent)]"
          {...register("consent")}
        />
        {formType === "newsletter" ? t.consentNewsletter : t.consent}
      </label>
      {err("consent") && <p className="text-[13px] font-medium text-danger">{t.consentRequired}</p>}
      <Turnstile onToken={setCaptcha} action="page-form" />
      <Button
        type="submit"
        size="md"
        disabled={!hydrated || formState.isSubmitting || (turnstileEnabled && !captcha)}
      >
        {formState.isSubmitting ? t.sending : buttonLabel || t.send[formType]}
      </Button>
    </form>
  );
}
