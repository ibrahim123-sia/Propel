import type { Metadata } from "next";
import { HideChat } from "@/components/site/chat/chat-controls";
import { RenderSections, type SectionContext } from "@/components/site/sections/render-sections";
import { getHomePage } from "@/features/cms/queries";
import { getPublicMedia } from "@/features/media/queries";
import { getSettings } from "@/features/settings/queries";

export async function generateMetadata(): Promise<Metadata> {
  const [page, general, seo] = await Promise.all([
    getHomePage(),
    getSettings("general"),
    getSettings("seo"),
  ]);
  const og = await getPublicMedia(page?.ogImageId ?? seo.defaultOgImageId);
  return {
    title: { absolute: page?.seoTitle || general.agencyName },
    description: page?.seoDescription || seo.defaultMetaDescription || general.shortDescription,
    alternates: { canonical: "/" },
    robots: page?.noindex ? { index: false } : undefined,
    openGraph: og ? { images: [{ url: og.url }] } : undefined,
  };
}

/**
 * Home (06 §3): the page marked as home in the page builder, rendered from its sections.
 * Until one is published, only settings content shows (never hard-coded copy).
 */
export default async function HomePage() {
  const [page, general, market] = await Promise.all([
    getHomePage(),
    getSettings("general"),
    getSettings("market"),
  ]);
  if (!page || page.sections.length === 0) {
    return (
      <section className="section-y">
        <div className="container-site max-w-3xl">
          <h1 className="text-display">{general.agencyName}</h1>
          {general.shortDescription && <p className="mt-6 text-lg">{general.shortDescription}</p>}
        </div>
      </section>
    );
  }
  const ctx: SectionContext = {
    areaUnit: market.areaUnit,
    distanceUnit: market.distanceUnit,
    baseCurrency: { code: market.baseCurrency.code, decimals: market.baseCurrency.decimals },
    pageId: page.id,
  };
  return (
    <>
      {page.hideChat && <HideChat />}
      <RenderSections sections={page.sections} ctx={ctx} />
    </>
  );
}
