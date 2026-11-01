import { renderSVG } from "uqr";
import { readableOn } from "@/lib/contrast";
import { format } from "@/lib/i18n";
import { brochure as t } from "@/lib/i18n/dictionaries/brochure";
import { locationPlotSvg } from "./plot";
import type { BrochureData, BrochureFact, BrochureImage } from "./types";

/**
 * The brochure as one HTML document of exactly four A4 pages (11 §4): (1) cover photo, title,
 * price, key facts, logo; (2) gallery and description; (3) floor plan, facilities and the
 * payment plan (or unit types / details); (4) location with nearby places and distances, the
 * agent card with a WhatsApp QR code, permit number and reference. Every page has a fixed
 * height with overflow hidden, so long content is cut rather than spilling onto a fifth page.
 * Colours and fonts are the agency's branding tokens. Pure: images come through `src`.
 */

export type ImageSource = (image: BrochureImage, width: number) => string;

/** Bumped when the template changes, so cached PDFs are made again (part of the version). */
export const BROCHURE_TEMPLATE_VERSION = 1;

const esc = (s: string | number | null | undefined): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Google Fonts families with the weights each one has (asking for a missing one fails). */
const fontAxes: Record<string, string> = {
  Fraunces: ":wght@400;500",
  "Playfair Display": ":wght@400;500",
  "Cormorant Garamond": ":wght@400;500",
  "DM Serif Display": "",
  Lora: ":wght@400;500",
  "Libre Baskerville": ":wght@400;700",
};
const bodyAxes = ":wght@400;500;600;700";

export function fontsHref(display: string, body: string): string {
  const fam = (name: string, axes: string) => `family=${name.replace(/ /g, "+")}${axes}`;
  return `https://fonts.googleapis.com/css2?${fam(display, fontAxes[display] ?? "")}&${fam(body, bodyAxes)}&display=block`;
}

function styles(d: BrochureData): string {
  const c = d.branding.colors;
  const radius = d.branding.cornerStyle === "sharp" ? "4px" : "14px";
  const radiusLg = d.branding.cornerStyle === "sharp" ? "6px" : "22px";
  return `
@page { size: A4; margin: 0 }
:root {
  --bg: ${c.bg}; --surface: ${c.surface}; --surface-soft: ${c.surfaceSoft}; --surface-muted: ${c.surfaceMuted};
  --ink: ${c.ink}; --ink-soft: ${c.inkSoft}; --text: ${c.text}; --muted: ${c.textMuted}; --border: ${c.border};
  --accent: ${c.accent}; --on-accent: ${readableOn(c.accent)}; --accent-soft: ${c.accentSoft};
  --success: ${c.success}; --placeholder: ${c.photoPlaceholder};
  --display: "${d.branding.fontDisplay}", Georgia, serif;
  --body: "${d.branding.fontBody}", ui-sans-serif, system-ui, sans-serif;
  --r: ${radius}; --r-lg: ${radiusLg};
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--bg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: var(--body); color: var(--text); font-size: 9.5pt; line-height: 1.5; }
.page { position: relative; width: 210mm; height: 296mm; overflow: hidden; padding: 13mm 14mm 18mm; display: flex; flex-direction: column; gap: 6mm; break-after: page; }
.page:last-child { break-after: auto; }
.foot { position: absolute; inset-inline: 14mm; bottom: 7mm; display: flex; justify-content: space-between; gap: 6mm; font-size: 7.5pt; color: var(--muted); border-top: 0.3mm solid var(--border); padding-top: 2.5mm; }
h1, h2, h3 { font-family: var(--display); font-weight: 400; color: var(--ink); line-height: 1.1; }
h1 { font-size: 27pt; }
h2 { font-size: 17pt; }
h3 { font-size: 11.5pt; font-weight: 500; }
.eyebrow { font-size: 7.5pt; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.muted { color: var(--muted); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 6mm; min-height: 14mm; }
.logo img { display: block; max-height: 13mm; max-width: 62mm; object-fit: contain; }
.logo span { font-family: var(--display); font-size: 17pt; color: var(--ink); }
.chip { display: inline-block; border-radius: 999px; padding: 1.2mm 3.2mm; font-size: 8pt; font-weight: 600; background: var(--surface); color: var(--ink); }
.chip.accent { background: var(--accent); color: var(--on-accent); }
.photo { position: relative; overflow: hidden; border-radius: var(--r-lg); background: var(--placeholder); }
.photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
.photo .chip { position: absolute; top: 4mm; inset-inline-start: 4mm; }
.cover { height: 138mm; flex-shrink: 0; }
.title { display: flex; flex-direction: column; gap: 2mm; }
.title h1 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.price { display: flex; align-items: baseline; gap: 4mm; flex-wrap: wrap; }
.price strong { font-size: 19pt; font-weight: 700; color: var(--ink); }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.fact { background: var(--surface); border-radius: var(--r); padding: 3mm 3.5mm; }
.fact b { display: block; font-size: 11pt; font-weight: 600; color: var(--ink); margin-top: 0.6mm; }
.gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
.gallery .photo { height: 48mm; border-radius: var(--r); }
.about { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 3mm; overflow: hidden; position: relative; }
.rich { color: var(--text); font-size: 9.5pt; }
.rich p, .rich ul, .rich ol { margin-bottom: 2mm; }
.rich ul, .rich ol { padding-inline-start: 5mm; }
.rich h2, .rich h3 { font-family: var(--body); font-size: 10pt; font-weight: 600; margin: 2mm 0 1mm; }
.rich a { color: var(--ink); }
.fade { position: absolute; inset-inline: 0; bottom: 0; height: 12mm; background: linear-gradient(to bottom, transparent, var(--bg)); }
.highlights { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5mm 6mm; list-style: none; }
.highlights li { display: flex; gap: 2mm; align-items: baseline; }
.highlights li::before { content: ""; flex: none; width: 1.6mm; height: 1.6mm; border-radius: 50%; background: var(--accent); transform: translateY(-0.4mm); }
.two { display: grid; grid-template-columns: 1.25fr 1fr; gap: 6mm; }
.card { background: var(--surface); border-radius: var(--r-lg); padding: 5mm; display: flex; flex-direction: column; gap: 3mm; }
.plan-img { height: 98mm; display: flex; align-items: center; justify-content: center; background: var(--surface-soft); border-radius: var(--r); overflow: hidden; }
.plan-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
.plan-img p { color: var(--muted); padding: 6mm; text-align: center; }
.ticks { list-style: none; columns: 2; column-gap: 5mm; font-size: 9pt; }
.ticks li { break-inside: avoid; padding: 0.7mm 0; display: flex; gap: 2mm; }
.ticks li::before { content: "\\2713"; color: var(--success); font-weight: 700; }
.ticks.one { columns: 1; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th { text-align: start; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding: 1.8mm 2mm; border-bottom: 0.3mm solid var(--border); }
td { padding: 2mm; border-bottom: 0.3mm solid var(--border); color: var(--ink); }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
tfoot td { font-weight: 700; border-top: 0.4mm solid var(--ink); }
.plan-head { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.small { font-size: 8pt; }
.loc { display: grid; grid-template-columns: 88mm 1fr; gap: 6mm; align-items: start; }
.plot svg { display: block; width: 88mm; height: 88mm; }
.pois { list-style: none; display: flex; flex-direction: column; gap: 1.6mm; }
.pois li { display: grid; grid-template-columns: 6mm 1fr auto; gap: 2mm; align-items: baseline; border-bottom: 0.3mm solid var(--border); padding-bottom: 1.4mm; }
.pois .n { display: inline-flex; align-items: center; justify-content: center; width: 5mm; height: 5mm; border-radius: 50%; background: var(--ink); color: #fff; font-size: 7pt; font-weight: 700; }
.pois .d { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pois small { display: block; color: var(--muted); font-size: 7.5pt; }
.agent { display: grid; grid-template-columns: 26mm 1fr 34mm; gap: 5mm; align-items: center; }
.avatar { width: 26mm; height: 26mm; border-radius: 50%; overflow: hidden; background: var(--placeholder); display: flex; align-items: center; justify-content: center; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar.logo-only { background: var(--surface-soft); border-radius: var(--r); }
.avatar.logo-only img { object-fit: contain; padding: 2mm; }
.agent dl { display: grid; grid-template-columns: auto 1fr; gap: 0.8mm 3mm; font-size: 9pt; }
.agent dt { color: var(--muted); }
.agent dd { color: var(--ink); font-weight: 600; word-break: break-word; }
.qr { display: block; text-align: center; font-size: 7pt; color: var(--muted); }
.qr svg { display: block; width: 30mm; height: 30mm; margin: 0 auto 1mm; }
.trust { display: flex; flex-wrap: wrap; gap: 2mm 6mm; font-size: 9pt; color: var(--ink); }
.trust span b { font-weight: 600; }
.disclaimer { font-size: 7.5pt; color: var(--muted); }
a { color: inherit; text-decoration: none; }
`;
}

function facts(list: BrochureFact[], max: number): string {
  return list
    .slice(0, max)
    .map(
      (f) =>
        `<div class="fact"><span class="eyebrow">${esc(f.label)}</span><b>${esc(f.value)}</b></div>`,
    )
    .join("");
}

function footer(d: BrochureData, n: number): string {
  const left = [d.agency.name, d.agency.phone, d.agency.website].filter(Boolean).map(esc);
  const right = [
    d.reference ? `${t.pdf.reference} ${d.reference}` : null,
    format(t.pdf.page, { n }),
  ]
    .filter(Boolean)
    .map((s) => esc(s));
  return `<div class="foot"><span>${left.join(" · ")}</span><span>${right.join(" · ")}</span></div>`;
}

function logo(d: BrochureData, src: ImageSource): string {
  return d.agency.logo
    ? `<div class="logo"><img src="${esc(src(d.agency.logo, 640))}" alt="${esc(d.agency.name)}"></div>`
    : `<div class="logo"><span>${esc(d.agency.name)}</span></div>`;
}

function photo(
  img: BrochureImage | null,
  width: number,
  src: ImageSource,
  cls: string,
  extra = "",
) {
  return `<div class="photo ${cls}">${img ? `<img src="${esc(src(img, width))}" alt="${esc(img.alt)}">` : ""}${extra}</div>`;
}

function pageCover(d: BrochureData, src: ImageSource): string {
  const status = d.statusNote ? `<span class="chip accent">${esc(d.statusNote)}</span>` : "";
  return `<section class="page" data-page="1">
  <div class="top">${logo(d, src)}<span class="chip">${esc(d.eyebrow)}</span></div>
  ${photo(d.cover, 1920, src, "cover", status)}
  <div class="title">
    <h1>${esc(d.title)}</h1>
    ${d.subtitle ? `<p class="muted">${esc(d.subtitle)}</p>` : ""}
  </div>
  <div class="price"><strong>${esc(d.priceText)}</strong>${d.pricePerAreaText ? `<span class="muted">${esc(d.pricePerAreaText)}</span>` : ""}</div>
  <div><p class="eyebrow" style="margin-bottom:2mm">${esc(t.pdf.keyFacts)}</p><div class="facts">${facts(d.facts, 8)}</div></div>
  ${footer(d, 1)}
</section>`;
}

function pageGallery(d: BrochureData, src: ImageSource): string {
  const photos = d.gallery.slice(0, 6);
  const grid = photos.length
    ? `<div><h2 style="margin-bottom:3mm">${esc(t.pdf.gallery)}</h2><div class="gallery">${photos
        .map((p) => photo(p, 1080, src, ""))
        .join("")}</div></div>`
    : "";
  const highlights = d.highlights.length
    ? `<h3>${esc(t.pdf.highlights)}</h3><ul class="highlights">${d.highlights
        .slice(0, 10)
        .map((h) => `<li>${esc(h)}</li>`)
        .join("")}</ul>`
    : "";
  // The description HTML is rendered on the server from the editor's allowlisted JSON (lib/rich-text).
  const about =
    d.descriptionHtml || highlights
      ? `<div class="about"><h2>${esc(d.aboutTitle)}</h2>${d.descriptionHtml ? `<div class="rich">${d.descriptionHtml}</div>` : ""}${highlights}<div class="fade"></div></div>`
      : "";
  return `<section class="page" data-page="2">
  <div class="top">${logo(d, src)}<span class="eyebrow">${esc(d.title)}</span></div>
  ${grid}
  ${about}
  ${footer(d, 2)}
</section>`;
}

function planTable(d: BrochureData, maxRows = 9): string {
  if (!d.plan) return "";
  const rows = d.plan.rows.slice(0, maxRows);
  const withAmounts = rows.some((r) => r.amount);
  return `<div class="card">
    <div class="plan-head"><h3>${esc(t.pdf.plan)}</h3>${d.plan.label ? `<span class="chip accent">${esc(d.plan.label)}</span>` : ""}</div>
    <table><thead><tr><th>${esc(t.pdf.planStep)}</th><th>${esc(t.pdf.planWhen)}</th><th class="num">${esc(t.pdf.planShare)}</th>${withAmounts ? `<th class="num">${esc(t.pdf.planAmount)}</th>` : ""}</tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr><td>${esc(r.label)}</td><td>${esc(r.when)}</td><td class="num">${esc(r.percent)}</td>${withAmounts ? `<td class="num">${esc(r.amount ?? "")}</td>` : ""}</tr>`,
      )
      .join("")}</tbody>
    ${d.plan.total ? `<tfoot><tr><td colspan="2">${esc(t.pdf.planTotal)}</td><td class="num">100%</td>${withAmounts ? `<td class="num">${esc(d.plan.total)}</td>` : ""}</tr></tfoot>` : ""}
    </table>
    ${d.plan.notes ? `<p class="small muted">${esc(d.plan.notes)}</p>` : ""}
  </div>`;
}

function unitTable(d: BrochureData): string {
  if (d.unitTypes.length === 0) return "";
  return `<div class="card"><h3>${esc(t.pdf.unitTypes)}</h3>
    <table><thead><tr><th>${esc(t.pdf.unitType)}</th><th>${esc(t.pdf.unitBeds)}</th><th class="num">${esc(t.pdf.unitSize)}</th><th class="num">${esc(t.pdf.unitPrice)}</th></tr></thead>
    <tbody>${d.unitTypes
      .slice(0, 8)
      .map(
        (u) =>
          `<tr><td>${esc(u.name)}</td><td>${esc(u.beds)}</td><td class="num">${esc(u.size)}</td><td class="num">${esc(u.price)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}

function detailsTable(d: BrochureData): string {
  if (d.details.length === 0) return "";
  return `<div class="card"><h3>${esc(t.pdf.details)}</h3><table><tbody>${d.details
    .slice(0, 8)
    .map(
      (f) => `<tr><td class="muted">${esc(f.label)}</td><td class="num">${esc(f.value)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function pagePlans(d: BrochureData, src: ImageSource): string {
  const plan = d.floorPlan
    ? `<div class="plan-img"><img src="${esc(src(d.floorPlan, 1920))}" alt="${esc(d.floorPlan.alt)}"></div>`
    : `<div class="plan-img"><p>${esc(t.pdf.noFloorPlan)}</p></div>`;
  const facilities = d.facilities.length
    ? `<ul class="ticks${d.facilities.length <= 8 ? " one" : ""}">${d.facilities
        .slice(0, 24)
        .map((f) => `<li>${esc(f)}</li>`)
        .join("")}</ul>`
    : `<p class="muted">${esc(t.pdf.noFacilities)}</p>`;
  // Below the plan and facilities: the payment plan, then unit types (projects) or the details.
  const lower = [planTable(d), unitTable(d), d.plan || d.unitTypes.length ? "" : detailsTable(d)]
    .filter(Boolean)
    .join("");
  return `<section class="page" data-page="3">
  <div class="top">${logo(d, src)}<span class="eyebrow">${esc(d.title)}</span></div>
  <div class="two">
    <div class="card"><h3>${esc(d.floorPlan?.title ?? t.pdf.floorPlan)}</h3>${plan}</div>
    <div class="card"><h3>${esc(d.facilitiesTitle)}</h3>${facilities}</div>
  </div>
  ${lower}
  ${footer(d, 3)}
</section>`;
}

function pageLocation(d: BrochureData, src: ImageSource): string {
  const c = d.branding.colors;
  const loc = d.location;
  const pois = loc.pois.slice(0, 10);
  const plot = loc.center
    ? locationPlotSvg({
        center: loc.center,
        places: pois.flatMap((p) => (p.point ? [{ n: p.n, point: p.point }] : [])),
        distanceUnit: loc.distanceUnit,
        northLabel: t.pdf.north,
        colors: {
          ink: c.ink,
          accent: c.accent,
          accentSoft: c.accentSoft,
          border: c.border,
          muted: c.textMuted,
        },
        fontFamily: d.branding.fontBody,
      })
    : "";
  const list = pois.length
    ? `<ol class="pois">${pois
        .map(
          (p) =>
            `<li><span class="n">${p.n}</span><span>${esc(p.name)}<small>${esc(p.typeName)}</small></span><span class="d">${esc(p.distanceText)}</span></li>`,
        )
        .join("")}</ol>`
    : `<p class="muted">${esc(t.pdf.noNearby)}</p>`;
  const caption = loc.center
    ? `<p class="small muted" style="margin-top:2mm">${esc(loc.center.approx ? t.pdf.plotCaptionApprox : t.pdf.plotCaption)}</p>`
    : "";

  const k = d.contact;
  const face = k.photo
    ? `<div class="avatar"><img src="${esc(src(k.photo, 384))}" alt="${esc(k.name)}"></div>`
    : d.agency.logo
      ? `<div class="avatar logo-only"><img src="${esc(src(d.agency.logo, 384))}" alt="${esc(d.agency.name)}"></div>`
      : `<div class="avatar"><span style="font-family:var(--display);font-size:18pt;color:var(--ink)">${esc(k.name.slice(0, 1))}</span></div>`;
  const rows = [
    k.phone ? [t.pdf.phone, k.phone] : null,
    k.whatsappText ? [t.pdf.whatsapp, k.whatsappText] : null,
    k.email ? [t.pdf.email, k.email] : null,
  ].filter((r): r is [string, string] => r !== null);
  // Scanned on paper, tapped on screen (links in the PDF stay clickable).
  const qr = k.whatsappHref
    ? `<a class="qr" href="${esc(k.whatsappHref)}">${renderSVG(k.whatsappHref, { ecc: "M", border: 1, pixelSize: 6, blackColor: c.ink })}${esc(t.pdf.scan)}</a>`
    : "<div></div>";
  const trust = [
    d.permit ? `<span>${esc(d.permit.label)} <b>${esc(d.permit.number)}</b></span>` : null,
    d.reference ? `<span>${esc(t.pdf.reference)} <b>${esc(d.reference)}</b></span>` : null,
    d.agency.licenceNumber
      ? `<span>${esc(t.pdf.licence)} <b>${esc(d.agency.licenceNumber)}</b></span>`
      : null,
    `<span>${esc(t.pdf.viewOnline)}: <a href="${esc(d.pageUrl)}"><b>${esc(d.pageUrl.replace(/^https?:\/\//, ""))}</b></a></span>`,
  ]
    .filter(Boolean)
    .join("");

  return `<section class="page" data-page="4">
  <div class="top">${logo(d, src)}<span class="eyebrow">${esc(d.title)}</span></div>
  <div><h2>${esc(t.pdf.location)}</h2>${loc.areaName ? `<p class="muted">${esc(loc.areaName)}</p>` : ""}</div>
  <div class="loc">${plot ? `<div class="plot">${plot}${caption}</div>` : ""}<div><h3 style="margin-bottom:2mm">${esc(t.pdf.nearby)}</h3>${list}</div></div>
  <div class="card">
    <p class="eyebrow">${esc(k.heading)}</p>
    <div class="agent">${face}<div><h3 style="font-size:14pt">${esc(k.name)}</h3>${k.title ? `<p class="muted" style="margin-bottom:2mm">${esc(k.title)}</p>` : ""}<dl>${rows
      .map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`)
      .join("")}</dl></div>${qr}</div>
  </div>
  <div class="trust">${trust}</div>
  <p class="disclaimer">${esc(t.pdf.disclaimer)}</p>
  ${footer(d, 4)}
</section>`;
}

/**
 * The whole document. `src` turns an image into what the browser loads (absolute URL or data
 * URI). `webFonts: false` leaves out the Google Fonts stylesheet (tests never reach the network;
 * the fallback fonts are used).
 */
export function brochureHtml(
  d: BrochureData,
  src: ImageSource,
  options: { webFonts?: boolean } = {},
): string {
  const fonts =
    options.webFonts === false
      ? ""
      : `<link rel="stylesheet" href="${esc(fontsHref(d.branding.fontDisplay, d.branding.fontBody))}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(d.reference ? `${d.reference} · ${d.title}` : d.title)}</title>
<meta name="author" content="${esc(d.agency.name)}">
${fonts}
<style>${styles(d)}</style>
</head>
<body data-agency="${esc(d.agency.name)}">
${pageCover(d, src)}
${pageGallery(d, src)}
${pagePlans(d, src)}
${pageLocation(d, src)}
</body>
</html>`;
}

/**
 * "Download payment schedule" (06 §5.8, 07 §5): one page with the logo, the home or project,
 * its price and every step of the payment plan with amounts. Null when there is no plan.
 */
export function paymentScheduleHtml(
  d: BrochureData,
  src: ImageSource,
  options: { webFonts?: boolean; generatedOn: string },
): string | null {
  if (!d.plan) return null;
  const fonts =
    options.webFonts === false
      ? ""
      : `<link rel="stylesheet" href="${esc(fontsHref(d.branding.fontDisplay, d.branding.fontBody))}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(`${t.pdf.schedule} · ${d.reference ? `${d.reference} · ` : ""}${d.title}`)}</title>
<meta name="author" content="${esc(d.agency.name)}">
${fonts}
<style>${styles(d)}</style>
</head>
<body data-agency="${esc(d.agency.name)}">
<section class="page" data-page="1">
  <div class="top">${logo(d, src)}<span class="chip">${esc(t.pdf.schedule)}</span></div>
  <div class="title">
    <h1>${esc(d.title)}</h1>
    ${d.subtitle ? `<p class="muted">${esc(d.subtitle)}</p>` : ""}
  </div>
  <div class="price"><strong>${esc(d.priceText)}</strong>${d.reference ? `<span class="muted">${esc(d.reference)}</span>` : ""}</div>
  ${planTable(d, 40)}
  <p class="small muted">${esc(t.pdf.scheduleNote.replace("{date}", options.generatedOn))}</p>
  ${footer(d, 1)}
</section>
</body>
</html>`;
}
