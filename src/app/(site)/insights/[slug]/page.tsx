import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Breadcrumb } from "@/components/site/breadcrumb";
import { PostBody } from "@/components/site/content/post-body";
import { PostCard, postDate } from "@/components/site/content/post-card";
import { ShareLinks } from "@/components/site/content/share-links";
import { FooterSignup } from "@/components/site/newsletter/footer-signup";
import { ViewBeacon } from "@/components/site/content/view-beacon";
import { JsonLd } from "@/components/site/json-ld";
import { ListingCard } from "@/components/site/listings/listing-card";
import { MediaImage } from "@/components/site/media-image";
import { getPublicPost, type PublicPost } from "@/features/blog/public";
import { articleJsonLd, publisher } from "@/features/content/json-ld";
import { publicCards } from "@/features/listings/public-cards";
import { getPublicMedia } from "@/features/media/queries";
import { followRedirect } from "@/features/content/redirect";
import { getSettings } from "@/features/settings/queries";
import { cardContext } from "@/features/site/card-context";
import { fillTitlePattern, htmlToText } from "@/features/site/seo";
import { siteOrigin, siteUrl } from "@/features/site/url";
import { format, pages, site } from "@/lib/i18n";
import { content } from "@/lib/i18n/dictionaries/content";
import { shareImage } from "@/features/og/cards";

/** Per request: the slug (and the visitor's currency for listing cards) decide what renders. */
export const instant = false;

function description(p: PublicPost): string {
  return (
    p.seo.description ||
    p.excerpt ||
    htmlToText(p.segments.map((s) => (s.kind === "html" ? s.html : "")).join(" "), 155)
  );
}

export async function generateMetadata(props: PageProps<"/insights/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const p = await getPublicPost(slug);
  if (!p) return { title: site.errors.notFoundTitle };
  const seo = await getSettings("seo");
  const title =
    p.seo.title ||
    fillTitlePattern(seo.postTitlePattern, { title: p.title, category: p.category?.name }, p.title);
  const og = p.seo.ogImageId ? await getPublicMedia(p.seo.ogImageId) : null;
  const images = await shareImage("post", p.slug, og?.url);
  const text = description(p);
  return {
    title,
    description: text || undefined,
    alternates: { canonical: p.seo.canonicalUrl || `/insights/${p.slug}` },
    robots: p.seo.noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      type: "article",
      title,
      description: text || undefined,
      publishedTime: p.publishedAt,
      modifiedTime: p.updatedAt,
      authors: p.author ? [p.author.name] : undefined,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: text || undefined,
      images: images.map((i) => i.url),
    },
  };
}

/** /insights/[slug] (06 §9): cover, title, author, date, reading time, body and more. */
export default async function PostPage(props: PageProps<"/insights/[slug]">) {
  const { slug } = await props.params;
  const p = await getPublicPost(slug);
  if (!p) {
    await followRedirect(`/insights/${slug}`);
    notFound();
  }
  const t = content.insights;
  const origin = siteOrigin();
  const url = siteUrl(`/insights/${p.slug}`);
  const [general, org, website] = await Promise.all([
    getSettings("general"),
    publisher(origin),
    getSettings("website"),
  ]);
  const zone = general.timeZone;

  return (
    <article className="section-y">
      <div className="container-site flex flex-col gap-8">
        <Breadcrumb
          items={[
            { label: pages.common.home, href: "/" },
            { label: t.title, href: "/insights" },
            ...(p.category
              ? [{ label: p.category.name, href: `/insights/category/${p.category.slug}` }]
              : []),
            { label: p.title },
          ]}
          baseUrl={origin}
        />
        <header className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {p.category && (
            <a
              href={`/insights/category/${p.category.slug}`}
              className="self-start text-[13px] font-semibold tracking-wide text-accent uppercase hover:underline"
            >
              {p.category.name}
            </a>
          )}
          <h1 className="text-display">{p.title}</h1>
          {p.excerpt && <p className="text-lg leading-relaxed text-text">{p.excerpt}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[14px] text-text-muted">
            {p.author && (
              <span className="flex items-center gap-2">
                {p.author.photo && (
                  <span className="size-9 overflow-hidden rounded-full">
                    <MediaImage
                      src={p.author.photo.url}
                      alt=""
                      aspect="1 / 1"
                      sizes="36px"
                      maxWidth={128}
                    />
                  </span>
                )}
                {p.author.href ? (
                  <a href={p.author.href} className="font-semibold text-ink hover:underline">
                    {format(t.by, { name: p.author.name })}
                  </a>
                ) : (
                  <span className="font-semibold text-ink">
                    {format(t.by, { name: p.author.name })}
                  </span>
                )}
              </span>
            )}
            <time dateTime={p.publishedAt}>{postDate(p.publishedAt, zone)}</time>
            <span aria-hidden>·</span>
            <span>{format(t.readingTime, { minutes: p.readingMinutes })}</span>
          </div>
        </header>

        {p.cover && (
          <div className="mx-auto w-full max-w-5xl overflow-hidden rounded-[20px]">
            <MediaImage
              src={p.cover.url}
              alt={p.cover.alt}
              aspect="16 / 9"
              sizes="(min-width: 1100px) 1024px, 100vw"
              color={p.cover.dominantColor}
              priority
            />
          </div>
        )}

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <PostBody segments={p.segments} />
          {p.tags.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-[15px] font-semibold text-ink">{t.tags}</h2>
              <ul className="flex flex-wrap gap-2">
                {p.tags.map((tag) => (
                  <li key={tag.slug}>
                    <a
                      href={`/insights?tag=${tag.slug}`}
                      className="inline-flex rounded-full bg-surface-muted px-3 py-1 text-[13.5px] text-ink hover:bg-border"
                    >
                      {tag.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ShareLinks url={url} title={p.title} />
        </div>

        {/* 06 §9: when the agency runs a newsletter (Website -> Menus -> Footer). */}
        {website.footer.newsletter && <FooterSignup place="blog" />}

        {p.relatedPropertyIds.length > 0 && (
          <Suspense>
            <RelatedHomes ids={p.relatedPropertyIds} />
          </Suspense>
        )}

        {p.related.length > 0 && (
          <section aria-labelledby="related-posts" className="flex flex-col gap-5">
            <h2 id="related-posts" className="text-h2">
              {t.related}
            </h2>
            <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {p.related.map((r) => (
                <li key={r.id} className="flex">
                  <PostCard post={r} timeZone={zone} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <JsonLd
        data={articleJsonLd(p, { url, origin, description: description(p), publisher: org })}
      />
      <ViewBeacon postId={p.id} />
    </article>
  );
}

/** "Homes from this post" (06 §9: related listings from related_property_ids). */
async function RelatedHomes({ ids }: { ids: string[] }) {
  const [cards, ctx] = await Promise.all([publicCards(ids), cardContext()]);
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="related-homes" className="flex flex-col gap-5">
      <h2 id="related-homes" className="text-h2">
        {content.insights.relatedHomes}
      </h2>
      <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <li key={c.id}>
            <ListingCard listing={c} ctx={ctx} />
          </li>
        ))}
      </ul>
    </section>
  );
}
