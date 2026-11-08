ALTER TABLE "tenants" ADD COLUMN "report_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "report_hour" integer DEFAULT 8 NOT NULL;