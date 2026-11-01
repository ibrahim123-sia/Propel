import { notFound } from "next/navigation";
import { PageEditor } from "@/components/admin/pages/editor/page-editor";
import { getDb } from "@/db/client";
import { writingHelpersOn } from "@/features/ai/config";
import { loadPageEditorData } from "@/features/cms/page-admin";
import { PREVIEW_PURPOSE } from "@/features/cms/page-public";
import { PREVIEW_LINK_DAYS } from "@/features/cms/page-schema";
import { loadSettings } from "@/features/settings/queries";
import { requireAdminPage } from "@/lib/auth/guards";
import { signToken } from "@/lib/signed-token";

export const instant = false;
export const metadata = { title: "Page builder" };

/** The page builder for one page (08 §1 "Page editor"). */
export default async function PageEditorPage(props: PageProps<"/admin/website/pages/[id]">) {
  const { user } = await requireAdminPage();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const data = await loadPageEditorData(db, id);
  if (!data) notFound();
  const general = await loadSettings("general", db);
  // The editor's own preview link (same kind as a shared one; never shown to the admin).
  const token = await signToken(PREVIEW_PURPOSE, { p: id }, PREVIEW_LINK_DAYS * 86_400);
  return (
    <PageEditor
      data={data}
      previewSrc={`/preview/${token}?edit=1`}
      siteName={general.agencyName}
      readOnly={user.readOnly}
      aiHelpers={!user.readOnly && (await writingHelpersOn(db))}
    />
  );
}
