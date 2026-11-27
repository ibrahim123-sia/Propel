import type { Metadata } from "next";
import { NotFoundContent } from "@/components/site/not-found-content";
import { NotFoundLogger } from "@/components/site/not-found-logger";
import { SiteChrome } from "@/components/site/site-chrome";
import { site } from "@/lib/i18n";

export const metadata: Metadata = { title: site.errors.notFoundTitle, robots: { index: false } };

/** Addresses that match no route: the site's helpful 404 (06 §1). */
export default function NotFound() {
  return (
    <SiteChrome>
      <NotFoundContent />
      <NotFoundLogger />
    </SiteChrome>
  );
}
