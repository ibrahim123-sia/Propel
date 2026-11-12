import { customerReplyJob } from "@/features/ai/assistant/customer";
import { conversationSummaryJob } from "@/features/ai/assistant/summary";
import { embedBackfillJob, embedJob } from "@/features/ai/embeddings";
import { chatTopicsJob } from "@/features/ai/topics";
import {
  alertsNewListingJob,
  alertsPriceDropJob,
  alertsStatusChangeJob,
} from "@/features/alerts/jobs";
import { whatsappNotifyJob, whatsappSendJob } from "@/features/integrations/whatsapp/jobs";
import { whatsappTranscribeJob } from "@/features/integrations/whatsapp/transcribe-job";
import { leadProcessJob, leadScoreJob } from "@/features/leads/process";
import { mediaFetchUrlJob } from "@/features/media/fetch-url";
import { mediaProcessJob } from "@/features/media/process";
import { emailSendJob } from "@/features/notifications/email";
import { poiComputeJob, projectPoiComputeJob } from "@/features/pois/distances";
import { calendarSyncJob } from "@/features/integrations/google-calendar/calendar";
import { viewingNotifyJob } from "@/features/viewings/notify";
import { seoCrawlJob } from "@/features/seo/crawl-job";
import { roiReportJob } from "@/features/tools/roi-report";
import { dailySummaryJob } from "@/features/reports/daily";
import { demoResetJob } from "@/features/demo/reset";
import { weeklyReportJob } from "@/features/reports/weekly";
import { brochureRenderJob } from "@/features/brochure/jobs";
import type { JobDefinition } from "./types";

/** Every queue job by name (13-integrations-and-jobs.md §2). */
const jobs: JobDefinition[] = [
  alertsNewListingJob as JobDefinition,
  alertsPriceDropJob as JobDefinition,
  alertsStatusChangeJob as JobDefinition,
  emailSendJob as JobDefinition,
  leadProcessJob as JobDefinition,
  leadScoreJob as JobDefinition,
  whatsappSendJob as JobDefinition,
  whatsappNotifyJob as JobDefinition,
  whatsappTranscribeJob as JobDefinition,
  mediaProcessJob as JobDefinition,
  mediaFetchUrlJob as JobDefinition,
  poiComputeJob as JobDefinition,
  projectPoiComputeJob as JobDefinition,
  viewingNotifyJob as JobDefinition,
  calendarSyncJob as JobDefinition,
  seoCrawlJob as JobDefinition,
  roiReportJob as JobDefinition,
  weeklyReportJob as JobDefinition,
  dailySummaryJob as JobDefinition,
  demoResetJob as JobDefinition,
  brochureRenderJob as JobDefinition,
  embedJob as JobDefinition,
  embedBackfillJob as JobDefinition,
  customerReplyJob as JobDefinition,
  conversationSummaryJob as JobDefinition,
  chatTopicsJob as JobDefinition,
];

const byName = new Map(jobs.map((j) => [j.name, j]));

export function getJob(name: string): JobDefinition | undefined {
  return byName.get(name);
}

export function jobNames(): string[] {
  return [...byName.keys()].sort();
}
