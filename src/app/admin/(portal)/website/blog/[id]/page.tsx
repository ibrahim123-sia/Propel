import { notFound } from "next/navigation";
import { PostEditor } from "@/components/admin/blog/post-editor";
import { PageHeader } from "@/components/admin/page-header";
import { getDb } from "@/db/client";
import { writingHelpersOn } from "@/features/ai/config";
import { loadPostEditorData } from "@/features/blog/queries";
import { loadSettings } from "@/features/settings/queries";
import { requireAdminPage } from "@/lib/auth/guards";

export const instant = false;
export const metadata = { title: "Post" };

export default async function PostEditorPage(props: PageProps<"/admin/website/blog/[id]">) {
  const { user } = await requireAdminPage();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const data = await loadPostEditorData(db, id);
  if (!data) notFound();
  const general = await loadSettings("general", db);
  return (
    <>
      <PageHeader
        title={data.input.title}
        breadcrumb={[
          { label: "Website" },
          { label: "Blog", href: "/admin/website/blog" },
          { label: data.input.title },
        ]}
      />
      <PostEditor
        data={data}
        siteName={general.agencyName}
        readOnly={user.readOnly}
        aiHelpers={!user.readOnly && (await writingHelpersOn(db))}
      />
    </>
  );
}
