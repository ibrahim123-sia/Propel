import { SearchPage } from "@/components/site/search/search-page";
import { searchMetadata } from "@/features/search/metadata";

/** Per request: the URL decides what renders; data is cached. */
export const instant = false;

const preset = { purpose: "sale", completion: "off_plan" } as const;

export function generateMetadata(props: PageProps<"/off-plan">) {
  return searchMetadata(preset, props.searchParams);
}

/** Off-plan homes (06 §1). */
export default function OffPlanPage(props: PageProps<"/off-plan">) {
  return <SearchPage preset={preset} searchParams={props.searchParams} />;
}
