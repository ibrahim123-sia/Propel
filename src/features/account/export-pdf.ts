import "server-only";
import type { PdfBrand } from "@/features/reports/export";

/**
 * "Download my data" as a PDF (12 §2 "JSON + PDF"): the same data as the JSON file, laid out
 * for reading. Every top-level part is a section; lists of records become tables, a record a
 * list of fields. Generic on purpose, so a field added to the export shows up here too.
 */

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** "marketingConsentAt" -> "Marketing consent at". */
export function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function scalar(v: unknown, timeZone: string): string {
  if (v === null || v === undefined || v === "") return "–";
  if (v instanceof Date) return dateText(v, timeZone);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" && ISO.test(v)) return dateText(new Date(v), timeZone);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function dateText(d: Date, timeZone: string): string {
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

function block(value: unknown, timeZone: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `<p class="muted">Nothing here.</p>`;
    if (value.every(isRecord)) {
      const keys = [...new Set(value.flatMap((r) => Object.keys(r)))];
      const head = keys.map((k) => `<th>${escape(humanise(k))}</th>`).join("");
      const rows = value
        .map(
          (r) =>
            `<tr>${keys.map((k) => `<td>${escape(scalar(r[k], timeZone))}</td>`).join("")}</tr>`,
        )
        .join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `<ul>${value.map((v) => `<li>${escape(scalar(v, timeZone))}</li>`).join("")}</ul>`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `<p class="muted">Nothing here.</p>`;
    return `<dl>${entries
      .map(([k, v]) =>
        isRecord(v) || Array.isArray(v)
          ? `<dt>${escape(humanise(k))}</dt><dd>${block(v, timeZone)}</dd>`
          : `<dt>${escape(humanise(k))}</dt><dd>${escape(scalar(v, timeZone))}</dd>`,
      )
      .join("")}</dl>`;
  }
  return `<p>${escape(scalar(value, timeZone))}</p>`;
}

export function customerDataHtml(
  data: Record<string, unknown>,
  brand: PdfBrand,
  options: { timeZone: string; generatedAt: Date },
): string {
  const c = brand.colors;
  const sections = Object.entries(data)
    .map(
      ([k, v]) => `<section><h2>${escape(humanise(k))}</h2>${block(v, options.timeZone)}</section>`,
    )
    .join("");
  const logo = brand.logoUrl
    ? `<img src="${escape(brand.logoUrl)}" alt="${escape(brand.agencyName)}" style="max-height:40px">`
    : `<strong>${escape(brand.agencyName)}</strong>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your data</title>
<style>
@page { size: A4; margin: 16mm 14mm; }
body { font: 11px/1.45 system-ui, sans-serif; color: ${c.text}; margin: 0; }
h1 { font-size: 20px; color: ${c.ink}; margin: 16px 0 4px; }
h2 { font-size: 14px; color: ${c.ink}; margin: 22px 0 8px; border-bottom: 2px solid ${c.accent}; padding-bottom: 4px; }
.muted { color: ${c.textMuted}; }
table { width: 100%; border-collapse: collapse; margin: 4px 0; }
th, td { text-align: start; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid ${c.border}; word-break: break-word; }
th { color: ${c.ink}; font-weight: 600; background: ${c.bg}; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; }
dt { color: ${c.textMuted}; } dd { margin: 0; color: ${c.ink}; }
section { break-inside: auto; }
</style></head><body>
<header>${logo}</header>
<h1>Your data</h1>
<p class="muted">Everything ${escape(brand.agencyName)} keeps about your account, as of ${escape(
    dateText(options.generatedAt, options.timeZone),
  )}.</p>
${sections}
</body></html>`;
}
