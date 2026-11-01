import { loadShareCard, shareCardKinds, type ShareCardKind } from "@/features/og/cards";
import { inlineMedia } from "@/features/og/inline-media";
import { emptyShareCard, shareCardResponse } from "@/features/og/share-card";

/**
 * GET /og/property|project|area|post/[slug] (11 §10): the page's share card. A `?v=` that
 * matches the content is cached for a year; any other request gets a short cache.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ kind: string; slug: string }> },
): Promise<Response> {
  const { kind, slug } = await ctx.params;
  if (!(shareCardKinds as readonly string[]).includes(kind))
    return new Response("Not found", { status: 404 });
  const { data, brand, version } = await loadShareCard(kind as ShareCardKind, slug);
  if (!data) return emptyShareCard({ ...brand, logoUrl: await inlineMedia(brand.logoUrl, 256) });
  const asked = new URL(request.url).searchParams.get("v");
  const [image, logo] = await Promise.all([
    inlineMedia(data.image),
    inlineMedia(brand.logoUrl, 256),
  ]);
  return shareCardResponse(
    { ...data, image },
    { ...brand, logoUrl: logo },
    {
      versioned: asked === version,
    },
  );
}
