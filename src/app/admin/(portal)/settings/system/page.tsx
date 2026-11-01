import { PageHeader } from "@/components/admin/page-header";
import { DemoPanel } from "@/components/admin/system/demo-panel";
import { canResetInPlace } from "@/features/demo/reset";
import { env } from "@/lib/env";
import { SystemOverview } from "@/components/admin/settings/system-overview";
import { getDb } from "@/db/client";
import { loadSettings } from "@/features/settings/queries";
import {
  aiSpendThisMonthCents,
  cronStatus,
  integrationStatus,
  jobSortable,
  jobSummary,
  listJobRuns,
  runtimeInfo,
} from "@/features/system/queries";
import { cronTasks } from "@/jobs/cron";
import { jobNames } from "@/jobs/registry";
import { requireAdminPage } from "@/lib/auth/guards";
import { parseTableParams } from "@/lib/table-params";

export const metadata = { title: "System" };
export const instant = false;

export default async function SystemPage(props: PageProps<"/admin/settings/system">) {
  const { user } = await requireAdminPage();
  const params = parseTableParams(await props.searchParams, {
    sortable: jobSortable,
    defaultSort: { id: "newest", desc: false },
    pageSize: 30,
  });
  const db = await getDb();
  const [summary, integrations, cron, { rows, total }, ai, spent] = await Promise.all([
    jobSummary(db),
    integrationStatus(db),
    cronStatus(db),
    listJobRuns(params, db),
    loadSettings("ai", db),
    aiSpendThisMonthCents(),
  ]);
  const demo = await loadSettings("demo", db);
  return (
    <>
      <PageHeader
        title="System"
        description="Background jobs, scheduled tasks, integrations and AI spend."
        breadcrumb={[{ label: "Settings" }, { label: "System" }]}
      />
      <SystemOverview
        runtime={runtimeInfo()}
        summary={summary}
        integrations={integrations}
        ai={{ spentCents: spent, limitCents: ai.monthlySpendLimitCents }}
        cron={cron}
        runs={rows}
        total={total}
        page={params.page}
        pageSize={params.pageSize}
        sort={params.sort}
        jobNames={[
          ...jobNames(),
          ...cronTasks.filter((t) => t.name !== "jobs.run-due").map((t) => `cron:${t.name}`),
        ]}
        readOnly={user.readOnly}
      />
      {env().DEMO_MODE && (
        <DemoPanel
          preset={demo.preset}
          requested={demo.requestedPreset}
          lastResetAt={demo.lastResetAt}
          inPlace={canResetInPlace()}
          readOnly={user.readOnly}
        />
      )}
    </>
  );
}
