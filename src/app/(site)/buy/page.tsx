import { SearchPage } from "@/components/site/search/search-page";
import { searchMetadata } from "@/features/search/metadata";

/** Per request: the URL decides what renders; data is cached. */
export const instant = false;

const preset = { purpose: "sale" } as const;

export function generateMetadata(props: PageProps<"/buy">) {
  return searchMetadata(preset, props.searchParams);
}

/** Homes for sale (06 §1). */
export default function BuyPage(props: PageProps<"/buy">) {
  return <SearchPage preset={preset} searchParams={props.searchParams} />;
}
