import { format } from "@/lib/i18n";
import { valuation as t } from "@/lib/i18n/dictionaries/valuation";
import { formatMoney, type CurrencyFormat } from "@/lib/money";
import { formatArea, type AreaUnit } from "@/lib/units";

type OwnerCondition = keyof typeof t.home.conditions;
type OwnerUpgrade = keyof typeof t.home.upgradeOptions;

/** Words for an owner request in emails and the lead page. Client-safe. */

export type OwnerHome = {
  typeName: string | null;
  beds: number | null;
  /** m² */
  size: number | null;
  building: string | null;
  areaName: string | null;
};

/** "2-bed apartment, 1,280 sq ft, Marina Gate, Dubai Marina". */
export function homeSummary(h: OwnerHome, unit: AreaUnit): string {
  const type = (h.typeName ?? "").toLowerCase();
  const what =
    h.beds == null
      ? h.typeName
      : h.beds === 0
        ? format(t.messages.studio, { type }).trim()
        : format(t.messages.bed, { beds: h.beds, type }).trim();
  return [what, h.size ? formatArea(h.size, unit) : null, h.building, h.areaName]
    .filter((x): x is string => Boolean(x && x.trim()))
    .join(", ");
}

/** "AED 1,970,000 – AED 2,270,000", with "per year" for rents. */
export function rangeText(
  low: number,
  high: number,
  currency: CurrencyFormat,
  period: "year" | "month" | null,
): string {
  const range = format(t.result.range, {
    low: formatMoney(low, currency),
    high: formatMoney(high, currency),
  });
  return period
    ? format(t.messages.rangeWithPeriod, { range, period: t.home.periods[period] })
    : range;
}

export const conditionLabel = (c: string | null): string | null =>
  c && c in t.home.conditions ? t.home.conditions[c as OwnerCondition] : null;

export const upgradeLabels = (keys: string[]): string[] =>
  keys
    .filter((k): k is OwnerUpgrade => k in t.home.upgradeOptions)
    .map((k) => t.home.upgradeOptions[k]);
