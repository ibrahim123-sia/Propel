import type { MediaItem } from "@/features/media/queries";
import type { ProjectActivity, ProjectEditorOptions } from "@/features/projects/editor-data";
import type { ProjectInput } from "@/features/projects/schema";
import type { CurrencyFormat } from "@/lib/money";
import type { AreaUnit, DistanceUnit } from "@/lib/units";

/** Settings the project editor needs from Market, General and Integrations (server-loaded). */
export type ProjectEditorMarket = {
  baseCurrency: string;
  currencies: Record<string, CurrencyFormat>;
  areaUnit: AreaUnit;
  distanceUnit: DistanceUnit;
  mapCenter: { lng: number; lat: number };
  mapZoom: number;
  styleUrl: string;
  siteName: string;
  /** Settings -> SEO title pattern for this kind of page, and the site title template. */
  titlePattern?: string;
  titleTemplate?: string;
};

export type ProjectSectionProps = {
  data: ProjectInput;
  set: (patch: Partial<ProjectInput>) => void;
  errorFor: (field: string) => string | undefined;
  options: ProjectEditorOptions;
  market: ProjectEditorMarket;
  media: Record<string, MediaItem>;
  rememberMedia: (items: MediaItem[]) => void;
  activity: ProjectActivity;
  readOnly: boolean;
  /** The writing helpers are on (10 §5). */
  aiHelpers?: boolean;
};
