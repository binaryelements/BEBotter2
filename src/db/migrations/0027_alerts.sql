CREATE TABLE "alert_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_bot_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_emails" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_low_balance" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_failures" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_approvals" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alert_balance_threshold" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_log" ADD CONSTRAINT "alert_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_log_tenant_idx" ON "alert_log" USING btree ("tenant_id","kind","created_at");