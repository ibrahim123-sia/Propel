"use client";

import { InfoIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LazyDialog } from "@/components/ui/lazy-dialog";
import {
  downPaymentOf,
  minDownPct,
  mortgageInputOf,
  mortgageRanges,
  mortgageSearch,
  MAX_PRICE_MAJOR,
  type MortgageDefaults,
  type MortgageState,
} from "@/features/tools/calculator-params";
import { downPaymentPct, mortgage, roundTo } from "@/features/tools/math";
import { format } from "@/lib/i18n";
import { calculators as t } from "@/lib/i18n/dictionaries/calculators";
import { formatMoney, type CurrencyFormat } from "@/lib/money";
import { StackedColumns } from "./charts";
import { CalcMoney, CalcNumber, ResultTile } from "./fields";
import { ShareLink, useCalculatorUrl } from "./share-link";

// The form (React Hook Form, Zod, Turnstile) loads when someone opens it, not with the page.
const PreApprovalForm = dynamic(
  () => import("./pre-approval-form").then((m) => m.PreApprovalForm),
  { ssr: false },
);

const PATH = "/tools/mortgage";

/** The mortgage calculator (11 §1): inputs, results, the yearly chart and the pre-approval. */
export function MortgageCalculator({
  initial,
  defaults,
  currency,
  incomeBands,
}: {
  initial: MortgageState;
  defaults: MortgageDefaults;
  currency: CurrencyFormat;
  /** Labels for the pre-approval form, from Settings -> Market. */
  incomeBands: string[];
}) {
  const [s, setS] = useState(initial);
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<MortgageState>) => setS((prev) => ({ ...prev, ...patch }));
  const money = (minor: number) => formatMoney(minor, currency);
  const m = useMemo(() => mortgage(mortgageInputOf(s, defaults)), [s, defaults]);
  const search = mortgageSearch(s, currency.decimals);
  useCalculatorUrl(PATH, search, "mortgage");

  const minPct = minDownPct(defaults);
  const down = downPaymentOf(s, defaults);
  const f = 10 ** currency.decimals;
  const pctText = (v: number) => String(roundTo(v, 2));

  return (
    <div className="flex flex-col gap-10">
      {s.ref && (
        <p className="flex items-center gap-2 text-[14px] text-text-muted">
          <InfoIcon className="size-4 text-accent" aria-hidden />
          {format(t.common.fromListing, { ref: s.ref })}
        </p>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="mortgage-inputs"
          className="flex flex-col gap-5 rounded-[20px] bg-surface p-5 shadow-soft sm:p-6"
        >
          <h2 id="mortgage-inputs" className="text-h3 text-ink">
            {t.mortgage.inputs}
          </h2>
          <CalcMoney
            label={t.mortgage.price}
            value={s.price}
            decimals={currency.decimals}
            max={MAX_PRICE_MAJOR}
            currencyCode={currency.code}
            onChange={(price) =>
              set({
                price,
                ...(s.downMode === "amount" ? { downAmount: Math.min(s.downAmount, price) } : {}),
              })
            }
          />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-[14px] font-semibold text-ink">
              {t.mortgage.downPayment}
            </legend>
            <div
              role="radiogroup"
              aria-label={t.mortgage.downMode}
              className="flex w-fit rounded-full bg-surface-muted p-1 text-[14px]"
            >
              {(["pct", "amount"] as const).map((mode) => (
                <label
                  key={mode}
                  className="cursor-pointer rounded-full px-4 py-1.5 font-semibold text-text has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    type="radio"
                    name="down-mode"
                    className="sr-only"
                    checked={s.downMode === mode}
                    onChange={() =>
                      set(
                        mode === "amount"
                          ? { downMode: "amount", downAmount: down }
                          : { downMode: "pct", downPct: roundTo(downPaymentPct(s.price, down), 2) },
                      )
                    }
                  />
                  {mode === "pct" ? t.mortgage.downPct : t.mortgage.downAmount}
                </label>
              ))}
            </div>
            {s.downMode === "pct" ? (
              <CalcNumber
                label={t.mortgage.downPayment}
                value={s.downPct}
                onChange={(downPct) => set({ downPct })}
                min={minPct}
                max={100}
                step={1}
                suffix={t.common.pctOfPrice}
                slider
                sliderLabel={t.mortgage.downSlider}
                help={money(down)}
              />
            ) : (
              <CalcMoney
                label={t.mortgage.downPayment}
                value={s.downAmount}
                decimals={currency.decimals}
                max={s.price / f}
                currencyCode={currency.code}
                onChange={(downAmount) => set({ downAmount })}
                help={`${pctText(downPaymentPct(s.price, down))}%`}
              />
            )}
            {minPct > 0 && (
              <p className="text-[13px] text-text-muted">
                {format(t.mortgage.downMin, { ltv: defaults.maxLtvPct, pct: pctText(minPct) })}
              </p>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <CalcNumber
              label={t.mortgage.years}
              value={s.years}
              onChange={(years) => set({ years: Math.round(years) })}
              min={1}
              max={defaults.maxYears}
              suffix={t.common.years}
              slider
              help={format(t.mortgage.yearsMax, { n: defaults.maxYears })}
            />
            <CalcNumber
              label={t.mortgage.rate}
              value={s.ratePct}
              onChange={(ratePct) => set({ ratePct })}
              min={mortgageRanges.ratePct.min}
              max={mortgageRanges.ratePct.max}
              step={0.05}
              suffix={t.common.pctPerYear}
            />
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-[14px] font-semibold text-ink">{t.mortgage.fees}</legend>
            <p className="text-[13px] text-text-muted">{t.mortgage.feesHelp}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <CalcNumber
                label={t.mortgage.registrationFee}
                value={s.registrationFeePct}
                onChange={(registrationFeePct) => set({ registrationFeePct })}
                min={0}
                max={mortgageRanges.feePct.max}
                step={0.1}
                suffix={t.common.percent}
                help={t.common.ofPrice}
              />
              <CalcNumber
                label={t.mortgage.agencyFee}
                value={s.agencyFeePct}
                onChange={(agencyFeePct) => set({ agencyFeePct })}
                min={0}
                max={mortgageRanges.feePct.max}
                step={0.1}
                suffix={t.common.percent}
                help={t.common.ofPrice}
              />
              <CalcNumber
                label={t.mortgage.arrangementFee}
                value={s.arrangementFeePct}
                onChange={(arrangementFeePct) => set({ arrangementFeePct })}
                min={0}
                max={mortgageRanges.feePct.max}
                step={0.1}
                suffix={t.common.percent}
                help={t.common.ofLoan}
              />
            </div>
          </fieldset>
        </section>

        <section aria-labelledby="mortgage-results" className="flex flex-col gap-5">
          <h2 id="mortgage-results" className="text-h3 text-ink">
            {t.mortgage.results}
          </h2>
          {m.price === 0 ? (
            <p className="text-[15px] text-text-muted">{t.mortgage.noPrice}</p>
          ) : (
            <dl aria-live="polite" className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <ResultTile
                  emphasis
                  label={t.mortgage.monthly}
                  value={money(m.monthlyPayment)}
                  help={
                    m.loan > 0
                      ? format(t.mortgage.monthlyFor, { years: s.years, rate: s.ratePct })
                      : t.mortgage.noLoan
                  }
                />
              </div>
              <ResultTile
                label={t.mortgage.loan}
                value={money(m.loan)}
                help={format(t.mortgage.ltv, { pct: pctText(m.ltvPct) })}
              />
              <ResultTile label={t.mortgage.totalInterest} value={money(m.totalInterest)} />
              <ResultTile
                label={t.mortgage.upfront}
                value={money(m.upfrontCash)}
                help={format(t.mortgage.upfrontHelp, {
                  down: money(m.downPayment),
                  fees: money(m.fees.total),
                })}
              />
              <ResultTile
                label={t.mortgage.totalCost}
                value={money(m.totalCost)}
                help={t.mortgage.totalCostHelp}
              />
            </dl>
          )}
          <p className="flex items-start gap-2 rounded-[16px] bg-accent-soft px-4 py-3 text-[14px] text-ink">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            {t.common.estimate}
          </p>
          <div className="flex flex-wrap items-start gap-3">
            <Button type="button" size="md" disabled={m.price === 0} onClick={() => setOpen(true)}>
              {t.mortgage.preApproval.cta}
            </Button>
            <ShareLink path={PATH} search={search} />
          </div>
        </section>
      </div>

      {m.schedule.length > 0 && (
        <section aria-labelledby="mortgage-chart" className="flex flex-col gap-4">
          <h2 id="mortgage-chart" className="text-h3 text-ink">
            {t.mortgage.chartTitle}
          </h2>
          <div className="rounded-[20px] bg-surface p-4 shadow-soft sm:p-6">
            <StackedColumns
              labels={m.schedule.map((y) => String(y.year))}
              series={[
                { name: t.mortgage.principal, color: "var(--color-ink)" },
                { name: t.mortgage.interest, color: "var(--color-accent)" },
              ]}
              values={m.schedule.map((y) => [y.principal / f, y.interest / f])}
              description={format(t.mortgage.chartLabel, {
                years: m.schedule.length,
                first: money(m.schedule[0]!.interest),
                last: money(m.schedule.at(-1)!.interest),
              })}
              formatValue={(v) => money(Math.round(v * f))}
              tooltipTitle={(i) => format(t.common.yearN, { n: i + 1 })}
            />
          </div>
          <details className="rounded-[16px] border border-border bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-[14.5px] font-semibold text-ink">
              {t.common.showTable}
            </summary>
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[28rem] text-[14px] tabular">
                <caption className="sr-only">{t.mortgage.chartTitle}</caption>
                <thead>
                  <tr className="text-start text-text-muted">
                    <th scope="col" className="py-2 text-start font-semibold">
                      {t.common.year}
                    </th>
                    <th scope="col" className="py-2 text-end font-semibold">
                      {t.mortgage.principal}
                    </th>
                    <th scope="col" className="py-2 text-end font-semibold">
                      {t.mortgage.interest}
                    </th>
                    <th scope="col" className="py-2 text-end font-semibold">
                      {t.mortgage.balance}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {m.schedule.map((y) => (
                    <tr key={y.year}>
                      <th scope="row" className="py-1.5 text-start font-medium text-ink">
                        {y.year}
                      </th>
                      <td className="py-1.5 text-end">{money(y.principal)}</td>
                      <td className="py-1.5 text-end">{money(y.interest)}</td>
                      <td className="py-1.5 text-end">{money(y.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      <LazyDialog
        open={open}
        onOpenChange={setOpen}
        title={t.mortgage.preApproval.title}
        description={format(t.mortgage.preApproval.summary, {
          loan: money(m.loan),
          years: s.years,
          monthly: money(m.monthlyPayment),
        })}
      >
        {open && (
          <PreApprovalForm
            incomeBands={incomeBands}
            listingRef={s.ref}
            calculation={{
              price: m.price,
              downPayment: m.downPayment,
              years: s.years,
              ratePct: s.ratePct,
              registrationFeePct: s.registrationFeePct,
              agencyFeePct: s.agencyFeePct,
              arrangementFeePct: s.arrangementFeePct,
            }}
            onDone={() => setOpen(false)}
          />
        )}
      </LazyDialog>
    </div>
  );
}
