import {
  MailIcon,
  MapPinIcon,
  MessageCircleIcon,
  PhoneIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { cn } from "cn";
import { resolveMapStyle } from "@/components/maps/map-style";
import { JsonLd } from "@/components/site/json-ld";
import { ListingCard } from "@/components/site/listings/listing-card";
import { PlaceMap } from "@/components/site/maps/place-map";
import { MediaImage } from "@/components/site/media-image";
import { LightboxProvider, LightboxTrigger } from "@/components/site/property/lightbox-provider";
import { withHeadingIds } from "@/features/cms/headings";
import { heroSearchOptions } from "@/features/cms/queries";
import {
  developerLogos,
  faqItems,
  mapSectionData,
  postCards,
  searchEmbedCards,
  teamTiles,
  testimonialCards,
  type TestimonialCard,
} from "@/features/cms/section-data";
import type { Section } from "@/features/cms/sections";
import { getPublicMedia } from "@/features/media/queries";
import { getSettings } from "@/features/settings/queries";
import { sanitizeHtml } from "@/lib/html-sanitize";
import { format } from "@/lib/i18n";
import { cms } from "@/lib/i18n/dictionaries/cms";
import { renderRichText } from "@/lib/rich-text";
import { videoEmbedUrl, videoThumbnailUrl } from "@/lib/video";
import { PageForm } from "./page-form";
import { Carousel, CustomHtmlScripts, SectionMap, VideoFacade } from "./section-clients";
import { Buttons, withCurrency, type SectionContext } from "./section-parts";
import { SectionHeading, SectionShell } from "./section-shell";

/** Renderers of the section types added with the page builder (08 §1). Server components. */

type Of<T extends Section["type"]> = Extract<Section, { type: T }>;

const ViewAll = ({ href, label }: { href?: string; label: string }) =>
  href ? (
    <a href={href} className="text-[15px] font-semibold underline-offset-4 hover:underline">
      {label}
    </a>
  ) : null;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

export async function SearchEmbed({ s, ctx }: { s: Of<"search_embed">; ctx: SectionContext }) {
  const [{ cards, total, href }, cardCtx] = await Promise.all([
    searchEmbedCards(s.props),
    withCurrency(ctx),
  ]);
  if (cards.length === 0) return null;
  const items = cards.map((c) => (
    <li key={c.id}>
      <ListingCard listing={c} ctx={cardCtx} />
    </li>
  ));
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading
        eyebrow={s.props.eyebrow}
        heading={s.props.heading}
        action={
          s.props.showViewAll ? (
            <ViewAll
              href={href}
              label={s.props.viewAllLabel || `${cms.sections.viewAll} (${total})`}
            />
          ) : null
        }
      />
      {s.props.layout === "carousel" ? (
        <Carousel label={s.props.heading || cms.sections.viewAll}>{items}</Carousel>
      ) : (
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{items}</ul>
      )}
    </SectionShell>
  );
}

const shapes = { portrait: "4 / 5", square: "1 / 1", landscape: "4 / 3" } as const;

export async function TextImage({ s, headingIds }: { s: Of<"text_image">; headingIds?: string[] }) {
  const image = await getPublicMedia(s.props.imageId);
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className={cn("grid items-center gap-10", image && "lg:grid-cols-2 lg:gap-16")}>
        <div className={cn(image && s.props.imageSide === "left" && "lg:order-2")}>
          {s.props.eyebrow && <p className="mb-2 text-eyebrow text-accent">{s.props.eyebrow}</p>}
          {s.props.heading && <h2 className="text-h2 text-ink">{s.props.heading}</h2>}
          <div
            className="rich-text mt-4 max-w-2xl text-[17px] text-text"
            // Rendered from the validated document by our own allowlist renderer (lib/rich-text).
            dangerouslySetInnerHTML={{
              __html: withHeadingIds(renderRichText(s.props.body), headingIds),
            }}
          />
          <Buttons buttons={s.props.buttons} />
        </div>
        {image && (
          <MediaImage
            src={image.url}
            alt={image.alt}
            sizes="(min-width: 1024px) 50vw, 100vw"
            aspect={shapes[s.props.imageShape]}
            color={image.dominantColor}
            className="rounded-[24px]"
          />
        )}
      </div>
    </SectionShell>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <p
      role="img"
      className="flex gap-0.5 text-accent"
      aria-label={format(cms.testimonials.rating, { n })}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <StarIcon
          key={i}
          className={cn("size-4", i < n ? "fill-current" : "opacity-30")}
          aria-hidden
        />
      ))}
    </p>
  );
}

function Quote({ t, big = false }: { t: TestimonialCard; big?: boolean }) {
  return (
    <figure
      className={cn(
        "flex h-full flex-col gap-4 rounded-[20px] bg-surface p-6 text-ink shadow-soft",
        big && "mx-auto max-w-3xl items-center p-8 text-center lg:p-12",
      )}
    >
      {t.rating ? <Stars n={t.rating} /> : null}
      <blockquote className={cn("leading-relaxed text-text", big ? "text-h3" : "text-[16px]")}>
        &ldquo;{t.quote}&rdquo;
      </blockquote>
      <figcaption className={cn("mt-auto flex items-center gap-3", big && "flex-col")}>
        {t.photo ? (
          <MediaImage
            src={t.photo.url}
            alt=""
            sizes="48px"
            aspect="1 / 1"
            maxWidth={256}
            className="size-12 shrink-0 overflow-hidden rounded-full"
          />
        ) : (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-[18px] text-accent"
            aria-hidden
          >
            {initials(t.name)}
          </span>
        )}
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{t.name}</span>
          {t.roleText && <span className="block text-[13px] text-text-muted">{t.roleText}</span>}
          {t.property && (
            <a
              href={`/property/${t.property.slug}`}
              className="block truncate text-[13px] text-accent hover:underline"
            >
              {t.property.title}
            </a>
          )}
        </span>
      </figcaption>
    </figure>
  );
}

export async function Testimonials({ s }: { s: Of<"testimonials"> }) {
  const items = await testimonialCards(s.props);
  if (items.length === 0) return null;
  const list = items.map((t) => (
    <li key={t.id} className="flex">
      <Quote t={t} />
    </li>
  ));
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
      {s.props.layout === "quote" ? (
        <Quote t={items[0]!} big />
      ) : s.props.layout === "carousel" ? (
        <Carousel label={s.props.heading || "Testimonials"}>{list}</Carousel>
      ) : (
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{list}</ul>
      )}
    </SectionShell>
  );
}

export async function Faq({ s, schema }: { s: Of<"faq">; schema: boolean }) {
  const items = await faqItems(s.props);
  if (items.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className="max-w-3xl">
        <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
        <div className="divide-y divide-border border-y border-border">
          {items.map((f) => (
            <details key={f.id} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {f.question}
                <PlusIcon
                  className="size-5 shrink-0 transition-transform group-open:rotate-45"
                  aria-hidden
                />
              </summary>
              <div
                className="rich-text mt-3 text-[16px] text-text"
                // Rendered from the stored document by our own allowlist renderer (lib/rich-text).
                dangerouslySetInnerHTML={{ __html: f.answerHtml }}
              />
            </details>
          ))}
        </div>
      </div>
      {schema && (
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: items.map((f) => ({
              "@type": "Question",
              name: f.question,
              acceptedAnswer: { "@type": "Answer", text: f.answerText },
            })),
          }}
        />
      )}
    </SectionShell>
  );
}

export async function Team({ s }: { s: Of<"team"> }) {
  const agents = await teamTiles(s.props);
  if (agents.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading
        eyebrow={s.props.eyebrow}
        heading={s.props.heading}
        action={
          s.props.viewAll?.href ? (
            <ViewAll
              href={s.props.viewAll.href}
              label={s.props.viewAll.label || cms.sections.viewAll}
            />
          ) : null
        }
      />
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {agents.map((a) => (
          <li key={a.id}>
            <article className="relative flex h-full flex-col overflow-hidden rounded-[20px] bg-surface text-ink shadow-soft">
              {a.photo ? (
                <MediaImage
                  src={a.photo.url}
                  alt={a.photo.alt}
                  sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
                  aspect="1 / 1"
                  color={a.photo.dominantColor}
                  maxWidth={828}
                />
              ) : (
                <div
                  className="flex aspect-square w-full items-center justify-center bg-accent-soft font-display text-[48px] text-accent"
                  aria-hidden
                >
                  {initials(a.name)}
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1 p-5">
                <h3 className="font-display text-[20px] text-ink">
                  <a
                    href={`/agents/${a.slug}`}
                    className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                  >
                    {a.name}
                  </a>
                </h3>
                {a.title && <p className="text-[14px] text-text-muted">{a.title}</p>}
                {a.languages.length > 0 && (
                  <p className="text-[13px] text-text-muted">
                    {format(cms.team.languages, { languages: a.languages.join(", ") })}
                  </p>
                )}
              </div>
            </article>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

export async function DeveloperLogos({ s }: { s: Of<"developer_logos"> }) {
  const list = await developerLogos(s.props);
  if (list.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
      <ul className="grid grid-cols-2 items-center gap-6 sm:grid-cols-3 lg:grid-cols-6">
        {list.map((d) => (
          <li key={d.id}>
            <a
              href={`/developers/${d.slug}`}
              className="flex h-20 items-center justify-center rounded-[16px] bg-surface px-4 text-ink opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0"
              title={d.name}
            >
              {d.logo ? (
                <MediaImage
                  src={d.logo.url}
                  alt={d.name}
                  sizes="160px"
                  aspect="3 / 2"
                  fit="contain"
                  maxWidth={384}
                  className="h-14 w-full"
                />
              ) : (
                <span className="text-center text-[15px] font-semibold">{d.name}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

const postDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export async function BlogPosts({ s }: { s: Of<"blog_posts"> }) {
  const list = await postCards(s.props);
  if (list.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading
        eyebrow={s.props.eyebrow}
        heading={s.props.heading}
        action={
          s.props.viewAll?.href ? (
            <ViewAll
              href={s.props.viewAll.href}
              label={s.props.viewAll.label || cms.sections.viewAll}
            />
          ) : null
        }
      />
      <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {list.map((p) => (
          <li key={p.id}>
            <article className="relative flex h-full flex-col overflow-hidden rounded-[20px] bg-surface text-ink shadow-soft">
              {p.cover ? (
                <MediaImage
                  src={p.cover.url}
                  alt=""
                  sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
                  aspect="16 / 10"
                  color={p.cover.dominantColor}
                />
              ) : (
                <div className="aspect-[16/10] bg-photo-placeholder" aria-hidden />
              )}
              <div className="flex flex-1 flex-col gap-2 p-5">
                <p className="text-[13px] text-text-muted">
                  {[
                    p.category,
                    p.publishedAt ? postDate.format(new Date(p.publishedAt)) : null,
                    format(cms.posts.minutes, { n: p.readingMinutes }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <h3 className="text-h3 text-ink">
                  <a
                    href={`/insights/${p.slug}`}
                    className="after:absolute after:inset-0 after:content-['']"
                  >
                    {p.title}
                  </a>
                </h3>
                {p.excerpt && <p className="line-clamp-3 text-[15px] text-text">{p.excerpt}</p>}
              </div>
            </article>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

async function formPropertyTypes(): Promise<string[]> {
  return (await heroSearchOptions()).types.map((t) => t.name);
}

export async function ContactBlock({ s, ctx }: { s: Of<"contact_block">; ctx: SectionContext }) {
  const [contact, integrations, types] = await Promise.all([
    getSettings("contact"),
    getSettings("integrations"),
    formPropertyTypes(),
  ]);
  const whatsapp = contact.whatsapp.replace(/\D/g, "");
  const point = s.props.showMap ? contact.officePoint : null;
  const details = s.props.showDetails && (contact.phone || contact.email || contact.address);
  const t = cms.contact;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className={cn("grid gap-10", s.props.showForm && "lg:grid-cols-[1fr_1.1fr] lg:gap-16")}>
        <div className="flex flex-col gap-6">
          <div>
            {s.props.eyebrow && <p className="mb-2 text-eyebrow text-accent">{s.props.eyebrow}</p>}
            {s.props.heading && <h2 className="text-h2 text-ink">{s.props.heading}</h2>}
            {s.props.text && <p className="mt-4 max-w-xl text-[17px] text-text">{s.props.text}</p>}
          </div>
          {details && (
            <dl className="grid gap-4 text-[15px] sm:grid-cols-2">
              {contact.phone && (
                <div>
                  <dt className="flex items-center gap-2 text-[13px] text-text-muted">
                    <PhoneIcon className="size-4" aria-hidden /> {t.phone}
                  </dt>
                  <dd>
                    <a
                      href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
                      className="font-semibold text-ink hover:underline"
                    >
                      {contact.phone}
                    </a>
                  </dd>
                </div>
              )}
              {whatsapp && (
                <div>
                  <dt className="flex items-center gap-2 text-[13px] text-text-muted">
                    <MessageCircleIcon className="size-4" aria-hidden /> {t.whatsapp}
                  </dt>
                  <dd>
                    <a
                      href={`https://wa.me/${whatsapp}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-ink hover:underline"
                    >
                      {contact.whatsapp}
                    </a>
                  </dd>
                </div>
              )}
              {contact.email && (
                <div>
                  <dt className="flex items-center gap-2 text-[13px] text-text-muted">
                    <MailIcon className="size-4" aria-hidden /> {t.email}
                  </dt>
                  <dd>
                    <a
                      href={`mailto:${contact.email}`}
                      className="font-semibold break-all text-ink hover:underline"
                    >
                      {contact.email}
                    </a>
                  </dd>
                </div>
              )}
              {contact.address && (
                <div>
                  <dt className="flex items-center gap-2 text-[13px] text-text-muted">
                    <MapPinIcon className="size-4" aria-hidden /> {t.address}
                  </dt>
                  <dd className="whitespace-pre-line text-ink">{contact.address}</dd>
                  {contact.officePoint && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${contact.officePoint.lat},${contact.officePoint.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-accent hover:underline"
                    >
                      {t.directions}
                    </a>
                  )}
                </div>
              )}
              {contact.openingHours && (
                <div className="sm:col-span-2">
                  <dt className="text-[13px] text-text-muted">{t.hours}</dt>
                  <dd className="whitespace-pre-line text-ink">{contact.openingHours}</dd>
                </div>
              )}
            </dl>
          )}
          {point && (
            <PlaceMap
              center={point}
              styleUrl={resolveMapStyle(integrations.googleMaps).styleUrl}
              label={cms.map.office}
              zoom={15}
            />
          )}
        </div>
        {s.props.showForm && (
          <div className="self-start rounded-[24px] bg-surface p-6 text-ink shadow-soft lg:p-8">
            {s.props.formHeading && (
              <h3 className="mb-4 text-h3 text-ink">{s.props.formHeading}</h3>
            )}
            <PageForm formType="contact" pageId={ctx.pageId ?? null} propertyTypes={types} />
          </div>
        )}
      </div>
    </SectionShell>
  );
}

export async function FormSection({ s, ctx }: { s: Of<"form">; ctx: SectionContext }) {
  const types = await formPropertyTypes();
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        <div>
          {s.props.eyebrow && <p className="mb-2 text-eyebrow text-accent">{s.props.eyebrow}</p>}
          {s.props.heading && <h2 className="text-h2 text-ink">{s.props.heading}</h2>}
          {s.props.text && <p className="mt-4 max-w-xl text-[17px] text-text">{s.props.text}</p>}
        </div>
        <div className="self-start rounded-[24px] bg-surface p-6 text-ink shadow-soft lg:p-8">
          <PageForm
            formType={s.props.formType}
            pageId={ctx.pageId ?? null}
            buttonLabel={s.props.buttonLabel || undefined}
            successMessage={s.props.successMessage || undefined}
            propertyTypes={types}
          />
        </div>
      </div>
    </SectionShell>
  );
}

export async function Video({ s }: { s: Of<"video"> }) {
  if (!s.props.url) return null;
  const embed = videoEmbedUrl(s.props.url);
  const poster = await getPublicMedia(s.props.posterId);
  const aspect = s.props.aspect.replace(":", " / ");
  const thumb = poster ? null : videoThumbnailUrl(s.props.url);
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      {s.props.heading && <h2 className="mb-8 text-h2 text-ink">{s.props.heading}</h2>}
      <figure className={cn("mx-auto", s.props.aspect === "9:16" ? "max-w-sm" : "max-w-5xl")}>
        {embed ? (
          <VideoFacade
            embedUrl={embed}
            title={s.props.heading || s.props.caption}
            aspect={aspect}
            poster={
              poster ? (
                <MediaImage
                  src={poster.url}
                  alt=""
                  sizes="(min-width: 1024px) 1000px, 100vw"
                  aspect={aspect}
                  color={poster.dominantColor}
                />
              ) : thumb ? (
                // eslint-disable-next-line @next/next/no-img-element -- the video service's own still
                <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
              ) : null
            }
          />
        ) : (
          <video
            controls
            preload="none"
            playsInline
            src={s.props.url}
            poster={poster ? `${poster.url}?w=1200&q=75` : undefined}
            className="w-full rounded-[20px] bg-ink"
            style={{ aspectRatio: aspect }}
          />
        )}
        {s.props.caption && (
          <figcaption className="mt-3 text-center text-[14px] text-text-muted">
            {s.props.caption}
          </figcaption>
        )}
      </figure>
    </SectionShell>
  );
}

const gridCols = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};
const masonryCols = {
  2: "sm:columns-2",
  3: "sm:columns-2 lg:columns-3",
  4: "sm:columns-2 lg:columns-4",
};

export async function Gallery({ s }: { s: Of<"gallery"> }) {
  const files = await Promise.all(s.props.images.map((img) => getPublicMedia(img.mediaId)));
  const images = s.props.images.flatMap((img, i) =>
    files[i] ? [{ ...img, file: files[i]!, alt: img.alt || files[i]!.alt }] : [],
  );
  if (images.length === 0) return null;
  const cols = (s.props.columns as 2 | 3 | 4) in gridCols ? (s.props.columns as 2 | 3 | 4) : 3;
  const tile = (img: (typeof images)[number], i: number, aspect: string) => (
    <figure>
      <LightboxTrigger
        index={i}
        label={format(cms.gallery.open, { n: i + 1, count: images.length })}
        className="block w-full overflow-hidden rounded-[16px]"
      >
        <MediaImage
          src={img.file.url}
          alt={img.alt}
          sizes={`(min-width: 1024px) ${Math.round(100 / cols)}vw, (min-width: 640px) 50vw, 100vw`}
          aspect={aspect}
          color={img.file.dominantColor}
        />
      </LightboxTrigger>
      {img.caption && (
        <figcaption className="mt-2 text-[14px] text-text-muted">{img.caption}</figcaption>
      )}
    </figure>
  );
  const natural = (img: (typeof images)[number]) =>
    img.file.width && img.file.height ? `${img.file.width} / ${img.file.height}` : "4 / 3";
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
      <LightboxProvider
        title={s.props.heading || cms.gallery.open}
        media={{
          photos: images.map((img) => ({
            url: img.file.url,
            alt: img.alt,
            caption: img.caption || null,
          })),
          plans: [],
          videoUrl: null,
          tourUrl: null,
        }}
      >
        {s.props.layout === "carousel" ? (
          <Carousel label={s.props.heading || cms.gallery.open}>
            {images.map((img, i) => (
              <li key={`${img.mediaId}-${i}`}>{tile(img, i, "4 / 3")}</li>
            ))}
          </Carousel>
        ) : s.props.layout === "masonry" ? (
          <ul className={cn("gap-5 [&>li]:mb-5 [&>li]:break-inside-avoid", masonryCols[cols])}>
            {images.map((img, i) => (
              <li key={`${img.mediaId}-${i}`}>{tile(img, i, natural(img))}</li>
            ))}
          </ul>
        ) : (
          <ul className={cn("grid gap-5", gridCols[cols])}>
            {images.map((img, i) => (
              <li key={`${img.mediaId}-${i}`}>{tile(img, i, "4 / 3")}</li>
            ))}
          </ul>
        )}
      </LightboxProvider>
    </SectionShell>
  );
}

export async function MapSection({ s }: { s: Of<"map"> }) {
  const [market, contact, integrations, data] = await Promise.all([
    getSettings("market"),
    getSettings("contact"),
    getSettings("integrations"),
    mapSectionData(s.props),
  ]);
  return (
    <SectionShell style={s.style} label={s.props.heading || cms.map.label}>
      {s.props.heading && <h2 className="mb-8 text-h2 text-ink">{s.props.heading}</h2>}
      <SectionMap
        styleUrl={resolveMapStyle(integrations.googleMaps).styleUrl}
        center={s.props.center ?? market.mapCenter}
        zoom={s.props.zoom}
        office={s.props.showOffice ? contact.officePoint : null}
        listings={data.listings.map((p) => ({
          id: p.id,
          lng: p.lng,
          lat: p.lat,
          href: `/property/${p.slug}`,
        }))}
        places={data.places.map((p) => ({ id: p.id, lng: p.lng, lat: p.lat, label: p.name }))}
        label={s.props.heading || cms.map.label}
        height={s.props.height}
      />
    </SectionShell>
  );
}

const dividerSpace = { small: "py-4", medium: "py-10", large: "py-20" } as const;

export function Divider({ s }: { s: Of<"divider"> }) {
  return (
    <div
      aria-hidden
      className={cn(
        dividerSpace[s.props.size],
        s.style.background === "ink"
          ? "bg-ink"
          : s.style.background === "sand"
            ? "bg-bg"
            : s.style.background === "soft"
              ? "bg-surface-soft"
              : "bg-surface",
        s.style.hideOn === "phone" && "hidden md:block",
        s.style.hideOn === "desktop" && "md:hidden",
      )}
    >
      {s.props.line && (
        <div className={s.style.width === "full" ? "container-wide" : "container-site"}>
          <hr className={s.style.background === "ink" ? "border-surface/20" : "border-border"} />
        </div>
      )}
    </div>
  );
}

export async function CustomHtml({ s }: { s: Of<"custom_html"> }) {
  const security = await getSettings("security");
  const { html, scripts } = sanitizeHtml(s.props.html, {
    allowScripts: security.allowCustomHtmlScripts,
  });
  if (!html.trim() && scripts.length === 0) return null;
  return (
    <SectionShell style={s.style}>
      <div
        className="rich-text custom-html text-[16px] text-text"
        // Cleaned by the allowlist sanitizer (lib/html-sanitize): only safe tags and attributes.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {scripts.length > 0 && <CustomHtmlScripts scripts={scripts} />}
    </SectionShell>
  );
}
