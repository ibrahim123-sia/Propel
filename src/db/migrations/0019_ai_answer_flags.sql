ALTER TABLE "messages" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "flagged_by" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "flag_note" text;