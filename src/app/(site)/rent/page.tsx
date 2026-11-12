import { SearchPage } from "@/components/site/search/search-page";
import { searchMetadata } from "@/features/search/metadata";

/** Per request: the URL decides what renders; data is cached. */
export const instant = false;

const preset = { purpose: "rent" } as const;

export function generateMetadata(props: PageProps<"/rent">) {
  return searchMetadata(preset, props.searchParams);
}

/** Homes for rent (06 §1). */
export default function RentPage(props: PageProps<"/rent">) {
  return <SearchPage preset={preset} searchParams={props.searchParams} />;
}
