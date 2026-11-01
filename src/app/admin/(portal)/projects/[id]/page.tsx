import { notFound } from "next/navigation";
import { PageHeader } from "@/components/admin/page-header";
import { ProjectEditor } from "@/components/admin/projects/editor/project-editor";
import { resolveMapStyle } from "@/components/maps/map-style";
import { getDb } from "@/db/client";
import { writingHelpersOn } from "@/features/ai/config";
import { currencyFormats } from "@/features/properties/format";
import { loadProjectEditorData } from "@/features/projects/editor-data";
import { siteTitleTemplate } from "@/features/seo/titles";
import { loadSettings } from "@/features/settings/queries";
import { requireAdminPage } from "@/lib/auth/guards";

export const instant = false;
export const metadata = { title: "Project" };

export default async function ProjectEditorPage(props: PageProps<"/admin/projects/[id]">) {
  const { user } = await requireAdminPage();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const data = await loadProjectEditorData(db, id);
  if (!data) notFound();
  const market = await loadSettings("market", db);
  const integrations = await loadSettings("integrations", db);
  const general = await loadSettings("general", db);
  const seo = await loadSettings("seo", db);
  const style = resolveMapStyle(integrations.googleMaps);

  return (
    <>
      <PageHeader
        title={data.row.name}
        breadcrumb={[{ label: "Projects", href: "/admin/projects" }, { label: data.row.name }]}
      />
      <ProjectEditor
        id={data.row.id}
        initial={data.input}
        initialUpdatedAt={data.row.updatedAt.toISOString()}
        initialPublished={data.row.isPublished}
        progressUpdatedAt={data.row.progressUpdatedAt?.toISOString() ?? null}
        media={data.media}
        options={data.options}
        activity={data.activity}
        nearby={data.nearby}
        readOnly={user.readOnly}
        aiHelpers={!user.readOnly && (await writingHelpersOn(db))}
        market={{
          baseCurrency: market.baseCurrency.code,
          currencies: currencyFormats(market),
          areaUnit: market.areaUnit,
          distanceUnit: market.distanceUnit,
          mapCenter: market.mapCenter,
          mapZoom: market.mapZoom,
          styleUrl: style.styleUrl,
          siteName: general.agencyName,
          titlePattern: seo.projectTitlePattern,
          titleTemplate: siteTitleTemplate(seo.titlePattern, general.agencyName),
        }}
      />
    </>
  );
}
