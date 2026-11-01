import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/site/breadcrumb";
import { LandingChrome } from "@/components/site/landing-chrome";
import { SiteChrome } from "@/components/site/site-chrome";
import { RenderSections, sectionContext } from "@/components/site/sections/render-sections";
import { pageHeadings, type TocEntry } from "@/features/cms/headings";
import type { PublicPage } from "@/features/cms/page-public";
import { getSettings } from "@/features/settings/queries";
import { siteOrigin } from "@/features/site/url";
import { format, pages as pagesText } from "@/lib/i18n";
import { cms } from "@/lib/i18n/dictionaries/cms";

const heroTypes = new Set(["hero_search", "hero_simple"]);

/**
 * A page builder page in its template (08 §1 Templates): default (header, sections, footer),
 * landing (logo and phone only) or legal (narrow text with a table of contents). The page's
 * h1 is the first hero's heading, or the page title when the page starts with something else.
 */
export async function PageView({
  page,
  editable = false,
  banner,
}: {
  page: PublicPage;
  /** The page builder's preview (sections can be clicked to select them). */
  editable?: boolean;
  /** Shown over the page, e.g. the preview link's notice. */
  banner?: ReactNode;
}) {
  const [market, general] = await Promise.all([getSettings("market"), getSettings("general")]);
  const ctx = { ...sectionContext(market), pageId: page.id };
  const { toc, bySection } = pageHeadings(page.sections);

  if (page.template === "legal") {
    return (
      <SiteChrome hideChat={page.hideChat}>
        <LegalLayout page={page} toc={toc} timeZone={general.timeZone}>
          <RenderSections
            sections={page.sections}
            ctx={ctx}
            h1={false}
            editable={editable}
            headingIds={bySection}
          />
        </LegalLayout>
        {banner}
      </SiteChrome>
    );
  }

  const heroFirst = heroTypes.has(page.sections[0]?.type ?? "");
  const body = (
    <>
      {!heroFirst && (
        <div className="container-site pt-12 lg:pt-16">
          <h1 className="text-h1 text-ink">{page.title}</h1>
        </div>
      )}
      <RenderSections
        sections={page.sections}
        ctx={ctx}
        h1={heroFirst}
        editable={editable}
        headingIds={bySection}
      />
      {banner}
    </>
  );
  return page.template === "landing" ? (
    <LandingChrome>{body}</LandingChrome>
  ) : (
    <SiteChrome hideChat={page.hideChat}>{body}</SiteChrome>
  );
}

function LegalLayout({
  page,
  toc,
  timeZone,
  children,
}: {
  page: PublicPage;
  toc: TocEntry[];
  timeZone: string;
  children: ReactNode;
}) {
  const updated = page.publishedAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone }).format(
        new Date(page.publishedAt),
      )
    : null;
  return (
    <div className="pt-10 pb-6 lg:pt-14">
      <div className="container-site">
        <Breadcrumb
          items={[{ label: pagesText.common.home, href: "/" }, { label: page.title }]}
          baseUrl={siteOrigin()}
        />
        <h1 className="mt-4 max-w-3xl text-h1 text-ink">{page.title}</h1>
        {updated && (
          <p className="mt-3 text-[14px] text-text-muted">
            {format(cms.legal.lastUpdated, { date: updated })}
          </p>
        )}
      </div>
      <div className="container-site mt-8 grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
        {toc.length > 1 ? (
          <nav aria-labelledby="legal-toc" className="self-start lg:sticky lg:top-24">
            <h2 id="legal-toc" className="text-eyebrow text-text-muted">
              {cms.legal.onThisPage}
            </h2>
            <ol className="mt-3 flex flex-col gap-2 border-s border-border ps-4 text-[14px]">
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="text-text hover:text-accent">
                    {t.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : (
          <div className="hidden lg:block" />
        )}
        {/* Sections sit in the narrow text column: their own side padding is dropped here. */}
        <div className="max-w-3xl min-w-0 [&_.container-site]:max-w-none [&_.container-site]:px-0 [&_.container-wide]:max-w-none [&_.container-wide]:px-0 [&_section]:py-6 lg:[&_section]:py-8">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The notice on a shared preview link (never on the published page). */
export function PreviewBanner({ expiresAt, timeZone }: { expiresAt: string; timeZone: string }) {
  const until = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(expiresAt));
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-x-2 rounded-[14px] bg-ink px-4 py-3 text-center text-[14px] text-surface shadow-soft"
    >
      <strong className="font-semibold">{cms.preview.banner}</strong>
      <span className="text-surface/80">{format(cms.preview.expires, { date: until })}</span>
    </div>
  );
}
