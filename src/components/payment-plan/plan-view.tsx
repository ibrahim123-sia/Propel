import { DownloadIcon } from "lucide-react";
import { cn } from "cn";
import {
  formatPercent,
  planProblem,
  planTotalBasisPoints,
  stageLabels,
  stepAmounts,
  suggestSummaryLabel,
  toBasisPoints,
  type PlanStage,
  type PlanStep,
} from "@/features/payment-plans/schema";
import { formatMoney, type CurrencyFormat } from "@/lib/money";

/** One colour per stage, from the design tokens (02 §2). */
export const stageColors: Record<PlanStage, string> = {
  booking: "bg-accent",
  construction: "bg-ink-soft",
  handover: "bg-success",
  post_handover: "bg-text-muted",
};

const dueFormat = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDueDate(date: string): string {
  return dueFormat.format(new Date(`${date}T00:00:00Z`));
}

/**
 * The payment plan block as the site shows it (06 §8): label, a timeline bar and step cards
 * with percent, stage, timing and, when a price is known, the amount per step.
 */
export function PaymentPlanView({
  steps,
  summaryLabel,
  notes,
  price,
  className,
  headingLevel = 3,
  preview,
  scheduleHref,
}: {
  steps: ReadonlyArray<Omit<PlanStep, "id"> & { id?: string }>;
  summaryLabel?: string | null;
  notes?: string | null;
  price?: { amount: number; currency: CurrencyFormat } | null;
  className?: string;
  headingLevel?: 2 | 3;
  /** Admin preview: also says why an incomplete plan is not shown on the site. */
  preview?: boolean;
  /** The site's "Download payment schedule" PDF (06 §5.8). */
  scheduleHref?: string;
}) {
  const label = summaryLabel || suggestSummaryLabel(steps);
  const total = planTotalBasisPoints(steps);
  const amounts = price ? stepAmounts(price.amount, steps) : null;
  const problem = planProblem(steps);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const width = Math.max(total, 10_000);

  return (
    <section aria-label="Payment plan" className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading className="font-display text-[1.15rem] text-ink">Payment plan</Heading>
        {label && (
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12.5px] font-semibold text-accent">
            {label}
          </span>
        )}
      </div>

      {steps.length > 0 && (
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
          role="img"
          aria-label={steps
            .map((s) => `${formatPercent(toBasisPoints(s.percent))}% ${s.label}`)
            .join(", ")}
        >
          {steps.map((s, i) => (
            <div
              key={s.id ?? i}
              className={cn(
                "h-full border-e-2 border-surface last:border-e-0",
                stageColors[s.stage],
              )}
              style={{ width: `${(toBasisPoints(s.percent) / width) * 100}%` }}
            />
          ))}
        </div>
      )}

      <ol className="grid gap-3 sm:grid-cols-2">
        {steps.map((s, i) => {
          const bp = toBasisPoints(s.percent);
          return (
            <li
              key={s.id ?? i}
              className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-text-muted uppercase">
                <span className={cn("size-2 rounded-full", stageColors[s.stage])} aria-hidden />
                {stageLabels[s.stage]}
              </div>
              <p className="flex items-baseline gap-2">
                <span className="font-display text-[1.6rem] leading-none text-ink tabular">
                  {formatPercent(bp)}%
                </span>
                <span className="font-semibold text-ink">{s.label}</span>
              </p>
              {amounts && price && (
                <p className="text-[13.5px] font-semibold text-ink tabular">
                  {formatMoney(amounts[i]!, price.currency)}
                  {s.instalmentsCount ? (
                    <span className="font-normal text-text-muted">
                      {" "}
                      ({s.instalmentsCount} × about{" "}
                      {formatMoney(Math.round(amounts[i]! / s.instalmentsCount), price.currency)})
                    </span>
                  ) : null}
                </p>
              )}
              {(s.timingText || s.instalmentsCount || s.dueDate) && (
                <p className="text-[13px] text-text">
                  {[
                    s.timingText,
                    s.instalmentsCount && !amounts ? `${s.instalmentsCount} instalments` : "",
                    s.dueDate ? `Due ${formatDueDate(s.dueDate)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {notes && <p className="text-[13px] whitespace-pre-line text-text-muted">{notes}</p>}
      {scheduleHref && !problem && (
        <a
          href={scheduleHref}
          download
          className="inline-flex items-center gap-2 self-start text-[14px] font-semibold text-accent hover:underline print:hidden"
        >
          <DownloadIcon className="size-4" aria-hidden />
          Download payment schedule (PDF)
        </a>
      )}
      {preview && problem && steps.length > 0 && (
        <p className="text-[13px] font-medium text-danger">Not shown on the site yet: {problem}</p>
      )}
    </section>
  );
}
