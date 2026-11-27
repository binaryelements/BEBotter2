CREATE TABLE "turn_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"chat_id" text,
	"audit_id" text,
	"workflow_run_id" text,
	"node_id" text,
	"step_started_at" timestamp with time zone,
	"started_by" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"messages" jsonb NOT NULL,
	"sent_count" integer NOT NULL,
	"stop_reason" text NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_logs" ADD CONSTRAINT "turn_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_logs" ADD CONSTRAINT "turn_logs_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_logs" ADD CONSTRAINT "turn_logs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_logs_audit_idx" ON "turn_logs" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "turn_logs_workflow_run_idx" ON "turn_logs" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "turn_logs_tenant_created_idx" ON "turn_logs" USING btree ("tenant_id","created_at");