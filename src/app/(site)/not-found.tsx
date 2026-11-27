import { NotFoundContent } from "@/components/site/not-found-content";
import { NotFoundLogger } from "@/components/site/not-found-logger";

/** A record that does not exist or is not public (notFound() in a site page). */
export default function SiteNotFound() {
  return (
    <>
      <NotFoundContent />
      <NotFoundLogger />
    </>
  );
}
