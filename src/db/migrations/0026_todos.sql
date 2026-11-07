CREATE TABLE "todos" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"person_id" text NOT NULL,
	"definition_id" text,
	"request_id" text,
	"title" text NOT NULL,
	"details" text,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_request_id_assistant_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."assistant_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todos_person_idx" ON "todos" USING btree ("person_id","status","due_at");