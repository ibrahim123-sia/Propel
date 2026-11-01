import { notFound } from "next/navigation";
import { GuideEditor } from "@/components/admin/area-guides/guide-editor";
import { PageHeader } from "@/components/admin/page-header";
import { getDb } from "@/db/client";
import { writingHelpersOn } from "@/features/ai/config";
import { loadGuideEditorData } from "@/features/area-guides/queries";
import { loadSettings } from "@/features/settings/queries";
import { requireAdminPage } from "@/lib/auth/guards";

export const instant = false;
export const metadata = { title: "Area guide" };

export default async function AreaGuideEditorPage(
  props: PageProps<"/admin/website/area-guides/[id]">,
) {
  const { user } = await requireAdminPage();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const data = await loadGuideEditorData(db, id);
  if (!data) notFound();
  const general = await loadSettings("general", db);
  return (
    <>
      <PageHeader
        title={data.input.title}
        breadcrumb={[
          { label: "Website" },
          { label: "Area guides", href: "/admin/website/area-guides" },
          { label: data.input.title },
        ]}
      />
      <GuideEditor
        data={data}
        siteName={general.agencyName}
        readOnly={user.readOnly}
        aiHelpers={!user.readOnly && (await writingHelpersOn(db))}
      />
    </>
  );
}
