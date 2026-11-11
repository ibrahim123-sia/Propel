"use client";

import { CheckIcon, ImagePlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { FormAlert } from "@/components/auth/auth-card";
import { TextField } from "@/components/auth/text-field";
import { Turnstile, turnstileEnabled } from "@/components/forms/turnstile";
import { Button } from "@/components/ui/button";
import { sendValuationRequest, startOwnerPhotoUpload } from "@/features/valuation/actions";
import { rangeText } from "@/features/valuation/format";
import {
  OWNER_PHOTO_LIMIT,
  OWNER_PHOTO_MAX_MB,
  ownerConditions,
  ownerSteps,
  ownerUpgrades,
  valuationRequestSchema,
  type OwnerRequestResult,
} from "@/features/valuation/schema";
import { format } from "@/lib/i18n";
import { valuation as t } from "@/lib/i18n/dictionaries/valuation";
import { formatMoney, type CurrencyFormat } from "@/lib/money";
import { formatArea, type AreaUnit, areaUnitLabels } from "@/lib/units";
import { useHydrated } from "@/lib/use-hydrated";

export type OwnerFormOptions = {
  /** Areas, communities and buildings, in tree order ("Dubai Marina", "— Marina Gate"). */
  locations: Array<{ id: string; label: string }>;
  types: Array<{ id: string; name: string; hidesBeds: boolean; hidesBaths: boolean }>;
  areaUnit: AreaUnit;
  currency: CurrencyFormat;
  rentPeriod: "year" | "month";
};

type Photo = {
  key: string;
  name: string;
  preview: string;
  status: "uploading" | "done" | "failed";
  receipt?: string;
  error?: string;
};

type Draft = {
  purpose: "sell" | "rent" | null;
  locationId: string;
  building: string;
  propertyTypeId: string;
  beds: string;
  baths: string;
  size: string;
  condition: string;
  upgrades: string[];
  askingPrice: string;
  availableFrom: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  consent: boolean;
  marketing: boolean;
  website: string;
};

const empty: Draft = {
  purpose: null,
  locationId: "",
  building: "",
  propertyTypeId: "",
  beds: "",
  baths: "",
  size: "",
  condition: "",
  upgrades: [],
  askingPrice: "",
  availableFrom: "",
  name: "",
  email: "",
  phone: "",
  notes: "",
  consent: false,
  marketing: false,
  website: "",
};

const num = (v: string): number | null => {
  const clean = v.replace(/[\s,]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : Number.NaN;
};

const selectClass =
  "h-11 w-full rounded-input border border-input bg-surface px-3 text-[15px] text-ink aria-[invalid=true]:border-danger";

/** One labelled select with its error linked (14 §4). */
function SelectBox({
  label,
  value,
  onChange,
  error,
  hint,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") ||
          undefined
        }
      >
        {children}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="text-[13px] text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-[13px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The free valuation (11 §5): five short steps (sell or rent,
 * where, the home, photos, contact), checked step by step and again on the server. A
 * valuation ends on the estimate with the homes it compared, or on "we need a quick look".
 */
export function OwnerRequestForm({ options }: { options: OwnerFormOptions }) {
  const hydrated = useHydrated();
  const formId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<OwnerRequestResult | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    // Move focus to the new step's heading, so screen readers hear where they are.
    if (moved.current) headingRef.current?.focus();
    moved.current = true;
  }, [step, result]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const type = options.types.find((x) => x.id === draft.propertyTypeId) ?? null;

  const payload = () => ({
    purpose: draft.purpose ?? undefined,
    locationId: draft.locationId || undefined,
    building: draft.building,
    propertyTypeId: draft.propertyTypeId || undefined,
    beds: type?.hidesBeds ? null : num(draft.beds),
    baths: type?.hidesBaths ? null : num(draft.baths),
    size: num(draft.size) ?? undefined,
    condition: draft.condition || null,
    upgrades: draft.upgrades,
    photos: photos.filter((p) => p.status === "done" && p.receipt).map((p) => p.receipt!),
    name: draft.name,
    email: draft.email,
    phone: draft.phone,
    notes: draft.notes,
    consent: draft.consent,
    marketing: draft.marketing,
    website: draft.website,
    captchaToken: captcha,
  });

  /** Errors for the fields of one step (or every step). */
  const check = (index: number | null): Record<string, string> => {
    const res = valuationRequestSchema.safeParse(payload());
    const fields: readonly string[] =
      index === null ? ownerSteps.flatMap((s) => s.fields) : ownerSteps[index]!.fields;
    const found: Record<string, string> = {};
    if (!res.success)
      for (const issue of res.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (fields.includes(key) && !found[key]) found[key] = issue.message;
      }
    if (fields.includes("beds") && type && !type.hidesBeds && draft.beds === "")
      found.beds ??= t.errors.beds;
    if (fields.includes("photos") && photos.some((p) => p.status === "uploading"))
      found.photos = t.errors.uploadsBusy;
    return found;
  };

  const next = () => {
    const found = check(step);
    setErrors(found);
    if (Object.keys(found).length === 0) setStep((s) => Math.min(s + 1, ownerSteps.length - 1));
  };

  const submit = async () => {
    const found = check(null);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      const first = ownerSteps.findIndex((s) => s.fields.some((f) => (f as string) in found));
      if (first >= 0 && first !== step) setStep(first);
      return;
    }
    setSending(true);
    const res = await sendValuationRequest(payload() as Parameters<typeof sendValuationRequest>[0]);
    setSending(false);
    if (res.ok) return setResult(res.data);
    const byField: Record<string, string> = {};
    for (const [path, messages] of Object.entries(res.fieldErrors ?? {}))
      byField[path.split(".")[0]!] = messages[0]!;
    setErrors(byField);
    const first = ownerSteps.findIndex((s) => s.fields.some((f) => (f as string) in byField));
    if (first >= 0) setStep(first);
    if (!res.fieldErrors) setFormError(res.error);
  };

  if (result) return <Result result={result} options={options} headingRef={headingRef} />;

  const stepKey = ownerSteps[step]!.key;
  const chip = (active: boolean) =>
    cn(
      "flex h-full flex-col gap-1 rounded-[16px] border px-4 py-3 text-start transition-colors",
      active
        ? "border-ink bg-ink text-surface"
        : "border-border bg-surface text-ink hover:border-ink/40",
    );

  return (
    <div className="flex flex-col gap-6">
      <ol aria-label={t.steps.label} className="flex flex-wrap gap-x-4 gap-y-2 text-[13.5px]">
        {ownerSteps.map((s, i) => (
          <li
            key={s.key}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5",
              i === step ? "font-semibold text-ink" : "text-text-muted",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-[12px]",
                i < step
                  ? "border-ink bg-ink text-surface"
                  : i === step
                    ? "border-ink"
                    : "border-border",
              )}
            >
              {i < step ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            {t.steps[s.key]}
          </li>
        ))}
      </ol>

      <form
        id={formId}
        noValidate
        className="relative flex flex-col gap-5 rounded-[20px] bg-surface p-5 shadow-soft sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < ownerSteps.length - 1) next();
          else void submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-text-muted">
            {format(t.steps.progress, { step: step + 1, total: ownerSteps.length })}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className="text-h3 text-ink outline-none">
            {t.steps[stepKey]}
          </h2>
        </div>
        {formError && <FormAlert>{formError}</FormAlert>}

        {stepKey === "purpose" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[15px] text-text">{t.purpose.legend}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["sell", "rent"] as const).map((p) => (
                <label key={p} className="flex">
                  <input
                    type="radio"
                    name={`${formId}-purpose`}
                    value={p}
                    className="peer sr-only"
                    checked={draft.purpose === p}
                    onChange={() => set("purpose", p)}
                    aria-describedby={errors.purpose ? `${formId}-purpose-err` : undefined}
                  />
                  <span
                    className={cn(
                      chip(draft.purpose === p),
                      "w-full peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                    )}
                  >
                    <span className="text-[16px] font-semibold">{t.purpose[p]}</span>
                    <span className="text-[13.5px] opacity-80">
                      {p === "sell" ? t.purpose.sellHint : t.purpose.rentHint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {errors.purpose && (
              <p id={`${formId}-purpose-err`} className="text-[13px] font-medium text-danger">
                {errors.purpose}
              </p>
            )}
          </fieldset>
        )}

        {stepKey === "location" && (
          <>
            <SelectBox
              label={t.location.area}
              value={draft.locationId}
              onChange={(v) => set("locationId", v)}
              error={errors.locationId}
              hint={t.location.areaHint}
            >
              <option value="">{t.location.choose}</option>
              {options.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </SelectBox>
            <TextField
              label={t.location.building}
              size="default"
              value={draft.building}
              onChange={(e) => set("building", e.target.value)}
              description={t.location.buildingHint}
              error={errors.building}
            />
          </>
        )}

        {stepKey === "home" && (
          <>
            <SelectBox
              label={t.home.type}
              value={draft.propertyTypeId}
              onChange={(v) => set("propertyTypeId", v)}
              error={errors.propertyTypeId}
            >
              <option value="">{t.home.chooseType}</option>
              {options.types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SelectBox>
            <div className="grid gap-4 sm:grid-cols-3">
              {!type?.hidesBeds && (
                <SelectBox
                  label={t.home.beds}
                  value={draft.beds}
                  onChange={(v) => set("beds", v)}
                  error={errors.beds}
                >
                  <option value="">{t.home.choose}</option>
                  <option value="0">{t.home.studio}</option>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </SelectBox>
              )}
              {!type?.hidesBaths && (
                <SelectBox
                  label={t.home.baths}
                  value={draft.baths}
                  onChange={(v) => set("baths", v)}
                  error={errors.baths}
                >
                  <option value="">{t.home.choose}</option>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </SelectBox>
              )}
              <TextField
                label={format(t.home.size, { unit: areaUnitLabels[options.areaUnit] })}
                size="default"
                inputMode="decimal"
                value={draft.size}
                onChange={(e) => set("size", e.target.value)}
                error={errors.size}
              />
            </div>
            <p className="-mt-2 text-[13px] text-text-muted">{t.home.sizeHint}</p>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[14px] font-semibold text-ink">
                {t.home.condition}
              </legend>
              <div className="flex flex-wrap gap-2">
                {ownerConditions.map((c) => (
                  <label key={c} className="flex">
                    <input
                      type="radio"
                      name={`${formId}-condition`}
                      className="peer sr-only"
                      checked={draft.condition === c}
                      onChange={() => set("condition", c)}
                    />
                    <span
                      className={cn(
                        "rounded-full border px-3.5 py-2 text-[14px] font-semibold peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                        draft.condition === c
                          ? "border-ink bg-ink text-surface"
                          : "border-border bg-surface text-ink",
                      )}
                    >
                      {t.home.conditions[c]}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[14px] font-semibold text-ink">{t.home.upgrades}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {ownerUpgrades.map((u) => (
                  <label key={u} className="flex items-center gap-2 text-[15px] text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-accent)]"
                      checked={draft.upgrades.includes(u)}
                      onChange={(e) =>
                        set(
                          "upgrades",
                          e.target.checked
                            ? [...draft.upgrades, u]
                            : draft.upgrades.filter((x) => x !== u),
                        )
                      }
                    />
                    {t.home.upgradeOptions[u]}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}

        {stepKey === "photos" && (
          <PhotoStep photos={photos} setPhotos={setPhotos} error={errors.photos} />
        )}

        {stepKey === "contact" && (
          <>
            <TextField
              label={t.contact.name}
              autoComplete="name"
              size="default"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              error={errors.name}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t.contact.email}
                type="email"
                autoComplete="email"
                size="default"
                value={draft.email}
                onChange={(e) => set("email", e.target.value)}
                error={errors.email}
              />
              <TextField
                label={t.contact.phone}
                type="tel"
                autoComplete="tel"
                size="default"
                value={draft.phone}
                onChange={(e) => set("phone", e.target.value)}
                error={errors.phone}
              />
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[14px] font-semibold text-ink">{t.contact.notes}</span>
              <textarea
                rows={3}
                className="rounded-input border border-input bg-surface px-3 py-2 text-[15px]"
                value={draft.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </label>
            {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
            <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
              <label htmlFor={`${formId}-website`}>Website</label>
              <input
                id={`${formId}-website`}
                tabIndex={-1}
                autoComplete="off"
                value={draft.website}
                onChange={(e) => set("website", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-[14px] text-text">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                  checked={draft.consent}
                  onChange={(e) => set("consent", e.target.checked)}
                  aria-describedby={errors.consent ? `${formId}-consent-err` : undefined}
                  aria-invalid={errors.consent ? true : undefined}
                />
                {t.contact.consent}
              </label>
              {errors.consent && (
                <p id={`${formId}-consent-err`} className="text-[13px] font-medium text-danger">
                  {errors.consent}
                </p>
              )}
            </div>
            <label className="flex items-start gap-2 text-[14px] text-text">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-[var(--color-accent)]"
                checked={draft.marketing}
                onChange={(e) => set("marketing", e.target.checked)}
              />
              {t.contact.marketing}
            </label>
            <Turnstile onToken={setCaptcha} action="owner-request" />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          {step > 0 ? (
            <Button
              type="button"
              variant="outline-site"
              size="md"
              onClick={() => {
                setErrors({});
                setStep((s) => s - 1);
              }}
            >
              {t.steps.back}
            </Button>
          ) : (
            <span />
          )}
          {step < ownerSteps.length - 1 ? (
            <Button type="submit" size="md" disabled={!hydrated}>
              {t.steps.next}
            </Button>
          ) : (
            <Button
              type="submit"
              size="md"
              disabled={!hydrated || sending || (turnstileEnabled && !captcha)}
            >
              {sending ? t.steps.sending : t.valuation.submit}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Step 4: optional photos, uploaded one by one to the signed links. */
function PhotoStep({
  photos,
  setPhotos,
  error,
}: {
  photos: Photo[];
  setPhotos: (fn: (p: Photo[]) => Photo[]) => void;
  error?: string;
}) {
  const inputId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const update = (key: string, patch: Partial<Photo>) =>
    setPhotos((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function upload(file: File, key: string) {
    const start = await startOwnerPhotoUpload({ fileName: file.name, size: file.size });
    if (!start.ok) return update(key, { status: "failed", error: start.error });
    try {
      const res = await fetch(start.data.uploadUrl, { method: "PUT", body: file });
      const body = (await res.json()) as { ok: boolean; receipt?: string; error?: string };
      if (!res.ok || !body.ok || !body.receipt)
        return update(key, { status: "failed", error: body.error ?? t.photos.failed });
      update(key, { status: "done", receipt: body.receipt });
    } catch {
      update(key, { status: "failed", error: t.photos.failed });
    }
  }

  function add(files: FileList | null) {
    if (!files) return;
    setNotice(null);
    const room = OWNER_PHOTO_LIMIT - photos.length;
    const picked = [...files];
    if (picked.length > room) setNotice(format(t.photos.tooMany, { max: OWNER_PHOTO_LIMIT }));
    const fresh: Photo[] = [];
    for (const file of picked.slice(0, Math.max(0, room))) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        setNotice(format(t.photos.wrongType, { name: file.name }));
        continue;
      }
      if (file.size > OWNER_PHOTO_MAX_MB * 1024 * 1024) {
        setNotice(format(t.photos.tooLarge, { name: file.name, mb: OWNER_PHOTO_MAX_MB }));
        continue;
      }
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      fresh.push({ key, name: file.name, preview: URL.createObjectURL(file), status: "uploading" });
      void upload(file, key);
    }
    setPhotos((list) => [...list, ...fresh]);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14.5px] text-text">
        {format(t.photos.hint, { max: OWNER_PHOTO_LIMIT, mb: OWNER_PHOTO_MAX_MB })} {t.photos.skip}
      </p>
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {photos.map((p, i) => (
            <li key={p.key} className="relative overflow-hidden rounded-[12px] bg-surface-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL) */}
              <img
                src={p.preview}
                alt={format(t.photos.alt, { n: i + 1 })}
                className={cn(
                  "aspect-[4/3] w-full object-cover",
                  p.status !== "done" && "opacity-60",
                )}
              />
              <p className="px-2 py-1 text-[12px] text-text-muted" role="status">
                {p.status === "uploading"
                  ? t.photos.uploading
                  : p.status === "failed"
                    ? (p.error ?? t.photos.failed)
                    : p.name}
              </p>
              <button
                type="button"
                className="absolute end-1.5 top-1.5 flex size-8 items-center justify-center rounded-full bg-ink/80 text-surface"
                aria-label={format(t.photos.remove, { n: i + 1 })}
                onClick={() => setPhotos((list) => list.filter((x) => x.key !== p.key))}
              >
                <XIcon className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {photos.length < OWNER_PHOTO_LIMIT && (
        <div>
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="peer sr-only"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
          <label
            htmlFor={inputId}
            className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-button border border-border bg-surface px-5 text-[15px] font-semibold text-ink peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50"
          >
            <ImagePlusIcon className="size-4" aria-hidden /> {t.photos.add}
          </label>
        </div>
      )}
      {(notice || error) && (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {error ?? notice}
        </p>
      )}
    </div>
  );
}

function Result({
  result,
  options,
  headingRef,
}: {
  result: OwnerRequestResult;
  options: OwnerFormOptions;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const e = result.estimate;
  const sent = result.email ? (
    <p className="text-[14px] text-text-muted">
      {format(t.result.emailSent, { email: result.email })}
    </p>
  ) : null;
  const box = "flex flex-col gap-4 rounded-[20px] bg-surface p-5 shadow-soft sm:p-8";

  if (result.kind === "listing" || !e)
    return (
      <section className={box} aria-live="polite">
        <h2 ref={headingRef} tabIndex={-1} className="text-h3 text-ink outline-none">
          {t.result.listingTitle}
        </h2>
        <p className="text-[16px] text-text">
          {format(t.result.listingNext, { agent: result.agentName })}
        </p>
        {sent}
      </section>
    );

  if (e.status === "not_enough_data")
    return (
      <section className={box} aria-live="polite">
        <h2 ref={headingRef} tabIndex={-1} className="text-h3 text-ink outline-none">
          {t.result.noNumberTitle}
        </h2>
        <p className="text-[16px] text-text">
          {format(t.result.noNumber, { area: result.areaName, agent: result.agentName })}
        </p>
        {sent}
      </section>
    );

  const money = (v: number) => formatMoney(v, options.currency);
  return (
    <section className={box} aria-live="polite">
      <h2 ref={headingRef} tabIndex={-1} className="text-h3 text-ink outline-none">
        {t.result.estimateTitle}
      </h2>
      <p
        className="font-display text-[30px] leading-tight text-ink sm:text-[36px]"
        data-testid="estimate-range"
      >
        {rangeText(e.low, e.high, options.currency, e.period)}
      </p>
      <p className="text-[15px] text-text">
        {format(e.comparables.length === 1 ? t.result.basedOnOne : t.result.basedOn, {
          count: e.comparables.length,
          area: result.areaName,
        })}
      </p>
      <p className="rounded-[14px] bg-accent-soft px-4 py-3 text-[15px] font-semibold text-ink">
        {t.result.refine}
      </p>
      <p className="text-[13.5px] text-text-muted">{t.result.disclaimer}</p>
      {sent}
      <h3 className="mt-2 text-[17px] font-semibold text-ink">{t.result.comparablesTitle}</h3>
      <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border">
        {e.comparables.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <Link
                href={`/property/${c.slug}`}
                prefetch={false}
                className="font-semibold text-ink hover:underline"
              >
                {c.title}
              </Link>
              <p className="text-[13px] text-text-muted">
                {[
                  c.beds == null
                    ? null
                    : c.beds === 0
                      ? t.result.studio
                      : format(t.result.beds, { beds: c.beds }),
                  formatArea(c.size, options.areaUnit),
                  c.locationName,
                  c.status === "sold" || c.status === "rented" ? t.result.status[c.status] : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <span className="font-semibold text-ink tabular">{money(c.price)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
