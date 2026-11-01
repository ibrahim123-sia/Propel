"use client";

import { useActionState, useId } from "react";
import { subscribeFromFooter, type FooterSignupState } from "@/features/newsletter/actions";
import { newsletter as t } from "@/lib/i18n/dictionaries/newsletter";

const initial: FooterSignupState = { status: "idle", message: "" };

/**
 * Newsletter signup: in the footer (Website -> Menus -> Footer, on the dark band) and under
 * blog posts (06 §9, on the page background). Works before hydration.
 */
export function FooterSignup({ place = "footer" }: { place?: "footer" | "blog" }) {
  const id = useId();
  const [state, action, pending] = useActionState(subscribeFromFooter, initial);
  const dark = place === "footer";
  const words = place === "blog" ? t.post : t.footer;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={dark ? "max-w-sm space-y-3" : "space-y-3 rounded-[20px] bg-surface-soft p-6"}
    >
      <h2 id={`${id}-title`} className={dark ? "text-eyebrow text-surface" : "text-h3 text-ink"}>
        {words.title}
      </h2>
      <p className={dark ? "text-[14px] text-surface/75" : "text-[15px] text-text-muted"}>
        {words.intro}
      </p>
      {state.status === "sent" ? (
        <p role="status" className={dark ? "text-[14px] text-surface" : "text-[15px] text-ink"}>
          {state.message}
        </p>
      ) : (
        <form action={action} className="flex max-w-md flex-col gap-2 sm:flex-row">
          <input type="hidden" name="source" value={place} />
          <label htmlFor={`${id}-email`} className="sr-only">
            {t.footer.label}
          </label>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder={t.footer.label}
            aria-invalid={state.status === "error" ? true : undefined}
            aria-describedby={state.status === "error" ? `${id}-error` : undefined}
            className={
              dark
                ? "h-11 min-w-0 flex-1 rounded-input border border-surface/25 bg-transparent px-3 text-[15px] text-surface placeholder:text-surface/50 focus-visible:border-surface focus-visible:outline-none"
                : "h-11 min-w-0 flex-1 rounded-input border border-input bg-surface px-3 text-[15px] text-ink placeholder:text-text-muted"
            }
          />
          {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
          <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
            <label htmlFor={`${id}-website`}>Website</label>
            <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" />
          </div>
          <button
            type="submit"
            disabled={pending}
            className={
              dark
                ? "h-11 rounded-button bg-surface px-5 text-[15px] font-semibold text-ink hover:bg-surface/90 disabled:opacity-60"
                : "h-11 rounded-button bg-accent px-5 text-[15px] font-semibold text-on-accent hover:bg-accent/90 disabled:opacity-60"
            }
          >
            {t.footer.submit}
          </button>
        </form>
      )}
      {state.status === "error" && (
        <p
          id={`${id}-error`}
          role="alert"
          className={dark ? "text-[13px] text-surface" : "text-[13px] text-danger"}
        >
          {state.message}
        </p>
      )}
    </section>
  );
}
