import { isWorkersRuntime } from "@/lib/env";

/**
 * HTML to PDF (01 §2 "PDF: Cloudflare Browser Rendering"): brochures and reports.
 * On Workers it drives the `BROWSER` binding (wrangler.jsonc); in development, tests and the
 * CI build it uses the Playwright Chromium that the e2e tests install. Server only.
 */

export type PdfOptions = {
  /** Page size; A4 unless the template sets its own with @page. */
  format?: "A4" | "Letter";
  landscape?: boolean;
};

export class PdfUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("PDF rendering is not available here", { cause });
    this.name = "PdfUnavailableError";
  }
}

/** The parts of a headless page both engines share. */
type HeadlessPage = {
  setContent(
    html: string,
    options: { waitUntil: "networkidle0" | "networkidle"; timeout: number },
  ): Promise<unknown>;
  pdf(options: {
    format: string;
    landscape: boolean;
    printBackground: boolean;
    preferCSSPageSize: boolean;
  }): Promise<Uint8Array>;
};
type HeadlessBrowser = { newPage(): Promise<HeadlessPage>; close(): Promise<void> };

async function launch(): Promise<{
  browser: HeadlessBrowser;
  waitUntil: "networkidle0" | "networkidle";
}> {
  if (isWorkersRuntime()) {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as { BROWSER?: unknown }).BROWSER;
    if (!binding)
      throw new PdfUnavailableError("The BROWSER binding is missing (see wrangler.jsonc).");
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    const browser = await puppeteer.launch(binding as Parameters<typeof puppeteer.launch>[0]);
    return { browser: browser as unknown as HeadlessBrowser, waitUntil: "networkidle0" };
  }
  // Outside Workers: Playwright's Chromium, loaded at run time so no bundle includes it. The
  // name comes through the environment: a plain string gets inlined by the minifier, and the
  // Workers bundler then tries to pull Playwright into the Worker.
  const specifier = process.env.PDF_CHROMIUM_MODULE || "@playwright/test";
  const { chromium } = (await import(
    /* turbopackIgnore: true */ /* webpackIgnore: true */ specifier
  )) as {
    chromium: { launch(): Promise<HeadlessBrowser> };
  };
  return { browser: await chromium.launch(), waitUntil: "networkidle" };
}

/** Renders a full HTML document (inline styles, absolute image URLs) to PDF bytes. */
export async function renderPdf(html: string, options: PdfOptions = {}): Promise<Uint8Array> {
  let started: Awaited<ReturnType<typeof launch>>;
  try {
    started = await launch();
  } catch (err) {
    throw err instanceof PdfUnavailableError ? err : new PdfUnavailableError(err);
  }
  const { browser, waitUntil } = started;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil, timeout: 30_000 });
    const bytes = await page.pdf({
      format: options.format ?? "A4",
      landscape: options.landscape ?? false,
      printBackground: true,
      preferCSSPageSize: true,
    });
    return new Uint8Array(bytes);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
