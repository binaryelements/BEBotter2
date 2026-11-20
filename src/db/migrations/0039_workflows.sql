CREATE TABLE "workflow_pending" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"input" jsonb,
	"input_hash" text,
	"choices" jsonb,
	"ask_person_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"answered_by_person_id" text,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"result" text,
	"reason" text,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"due_at" timestamp with time zone,
	"wait_started_at" timestamp with time zone,
	"step_started_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"keys" jsonb NOT NULL,
	"fields" jsonb NOT NULL,
	"pending_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reported_result" jsonb,
	"outcome" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"published_by_person_id" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_workflow_id_version_pk" PRIMARY KEY("workflow_id","version")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"name" text NOT NULL,
	"chat_id" text NOT NULL,
	"run_as_person_id" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "workflow_run_id" text;
ALTER TABLE "workflow_pending" ADD CONSTRAINT "workflow_pending_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_pending" ADD CONSTRAINT "workflow_pending_ask_person_id_people_id_fk" FOREIGN KEY ("ask_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_pending" ADD CONSTRAINT "workflow_pending_answered_by_person_id_people_id_fk" FOREIGN KEY ("answered_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_published_by_person_id_people_id_fk" FOREIGN KEY ("published_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_run_as_person_id_people_id_fk" FOREIGN KEY ("run_as_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "workflow_runs_workflow_status_idx" ON "workflow_runs" USING btree ("workflow_id","status");
