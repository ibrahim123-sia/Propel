import { Breadcrumb } from "@/components/site/breadcrumb";
import { siteOrigin } from "@/features/site/url";
import { ownerFormOptions } from "@/features/valuation/options";
import { pages } from "@/lib/i18n";
import { valuation as t } from "@/lib/i18n/dictionaries/valuation";
import { OwnerRequestForm } from "./owner-request-form";

/** /valuation (11 §5): a short intro and the step-by-step form. */
export async function OwnerRequestPage() {
  const copy = t.valuation;
  const options = await ownerFormOptions();
  return (
    <div className="section-y">
      <div className="container-site flex max-w-3xl flex-col gap-8">
        <Breadcrumb
          items={[{ label: pages.common.home, href: "/" }, { label: copy.title }]}
          baseUrl={siteOrigin()}
        />
        <header className="flex flex-col gap-3">
          <h1 className="text-display">{copy.title}</h1>
          <p className="text-lg leading-relaxed text-text">{copy.intro}</p>
        </header>
        <OwnerRequestForm options={options} />
      </div>
    </div>
  );
}
