import { ImageResponse } from "next/og";
import type { EmailBrand } from "@/emails/brand";

/**
 * Dynamic share cards (11 §10): a 1200×630 picture for og:image and twitter:image, drawn with
 * Satori (next/og), so a shared link shows the home, its price and facts instead of a bare
 * logo. Cards are cached for a year under a version of their content (`?v=`), so a change
 * (price, photo, title) gets a new address and the platforms fetch it again.
 */

export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

export type ShareCardData = {
  /** Absolute address of the photo, or null for a plain card. */
  image: string | null;
  eyebrow: string | null;
  title: string;
  /** The big line: a price, "From AED 1.2M", a reading time. */
  highlight: string | null;
  facts: string[];
  badge: string | null;
};

/** A short, stable version of what the card shows (part of its address). */
export async function shareCardVersion(data: ShareCardData, brand: EmailBrand): Promise<string> {
  const text = JSON.stringify([data, brand.agencyName, brand.logoUrl, brand.colors.accent]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function shareCardResponse(
  data: ShareCardData,
  brand: EmailBrand,
  options: { versioned: boolean },
): ImageResponse {
  const c = brand.colors;
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: c.bg }}>
      {data.image && (
        // eslint-disable-next-line @next/next/no-img-element -- Satori draws plain img tags
        <img
          src={data.image}
          alt=""
          width={660}
          height={630}
          style={{ width: 660, height: 630, objectFit: "cover" }}
        />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          flex: 1,
          padding: "56px 52px",
          background: c.surface,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {data.badge && (
            <div
              style={{
                display: "flex",
                alignSelf: "flex-start",
                padding: "8px 16px",
                borderRadius: 999,
                background: c.accent,
                color: c.onAccent,
                fontSize: 22,
              }}
            >
              {data.badge}
            </div>
          )}
          {data.eyebrow && (
            <div style={{ display: "flex", fontSize: 26, color: c.textMuted }}>{data.eyebrow}</div>
          )}
          <div
            style={{
              display: "flex",
              fontSize: data.title.length > 60 ? 40 : 48,
              lineHeight: 1.15,
              color: c.ink,
              fontWeight: 700,
            }}
          >
            {data.title.length > 110 ? `${data.title.slice(0, 107)}…` : data.title}
          </div>
          {data.highlight && (
            <div style={{ display: "flex", fontSize: 44, color: c.accent, fontWeight: 700 }}>
              {data.highlight}
            </div>
          )}
          {data.facts.length > 0 && (
            <div style={{ display: "flex", fontSize: 26, color: c.text }}>
              {data.facts.slice(0, 4).join("  ·  ")}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {brand.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- Satori draws plain img tags
            <img src={brand.logoUrl} alt="" height={48} style={{ height: 48 }} />
          )}
          <div style={{ display: "flex", fontSize: 26, color: c.ink }}>{brand.agencyName}</div>
        </div>
      </div>
    </div>,
    {
      ...SHARE_CARD_SIZE,
      headers: {
        // A versioned address never changes content; an unversioned one may.
        "cache-control": options.versioned
          ? "public, max-age=31536000, immutable"
          : "public, max-age=600",
      },
    },
  );
}

/** The card for a missing page: the agency's name only, cached briefly. */
export function emptyShareCard(brand: EmailBrand): ImageResponse {
  return shareCardResponse(
    {
      image: null,
      eyebrow: null,
      title: brand.agencyName,
      highlight: null,
      facts: [],
      badge: null,
    },
    brand,
    { versioned: false },
  );
}
