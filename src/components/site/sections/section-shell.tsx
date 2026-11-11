import type { ReactNode } from "react";
import { cn } from "cn";
import type { SectionStyle } from "@/features/cms/sections";
import { getPublicMedia } from "@/features/media/queries";

const backgrounds: Record<SectionStyle["background"], string> = {
  sand: "bg-bg",
  white: "bg-surface",
  soft: "bg-surface-soft",
  // Light text on the dark background; white cards inside keep their own colours
  // (section-dark in globals.css).
  ink: "section-dark bg-ink text-surface",
  image: "bg-ink text-surface [&_.text-eyebrow]:text-accent-soft",
};

const spacing: Record<SectionStyle["spacing"], string> = {
  compact: "py-10 lg:py-14",
  normal: "section-y",
  large: "py-24 lg:py-36",
};

/** "Section style" (08 §1): background, spacing, width, anchor id, hide on phone or desktop. */
export async function SectionShell({
  style,
  children,
  label,
  backgroundUrl: given,
}: {
  style: SectionStyle;
  children: ReactNode;
  /** Accessible name of the region (usually the section heading). */
  label?: string;
  backgroundUrl?: string | null;
}) {
  // "Image" background (08 §1 section style): the section's own picture, else the style's.
  const backgroundUrl =
    given ??
    (style.background === "image" ? (await getPublicMedia(style.backgroundImageId))?.url : null);
  return (
    <section
      id={style.anchor || undefined}
      aria-label={label || undefined}
      className={cn(
        "relative",
        backgrounds[style.background],
        spacing[style.spacing],
        style.hideOn === "phone" && "hidden md:block",
        style.hideOn === "desktop" && "md:hidden",
      )}
      style={
        style.background === "image" && backgroundUrl
          ? {
              backgroundImage: `linear-gradient(rgba(20,35,43,0.55), rgba(20,35,43,0.55)), url(${backgroundUrl}?w=1920&q=75)`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : undefined
      }
    >
      <div className={style.width === "full" ? "container-wide" : "container-site"}>{children}</div>
    </section>
  );
}

/** Eyebrow + heading + optional link row used by most sections. */
export function SectionHeading({
  eyebrow,
  heading,
  action,
}: {
  eyebrow?: string;
  heading?: string;
  action?: ReactNode;
}) {
  if (!eyebrow && !heading && !action) return null;
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 lg:mb-12">
      <div>
        {eyebrow && <p className="mb-2 text-eyebrow text-accent">{eyebrow}</p>}
        {heading && <h2 className="text-h2 text-ink">{heading}</h2>}
      </div>
      {action}
    </div>
  );
}
