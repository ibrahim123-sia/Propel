import type { Metadata } from "next";
import { OwnerRequestPage } from "@/components/site/valuation/owner-request-page";
import { valuation as t } from "@/lib/i18n/dictionaries/valuation";

export const metadata: Metadata = {
  title: t.valuation.metaTitle,
  description: t.valuation.metaDescription,
  alternates: { canonical: "/valuation" },
};

/** /valuation (11 §5): the free valuation from comparable own listings. */
export default function ValuationPage() {
  return <OwnerRequestPage />;
}
