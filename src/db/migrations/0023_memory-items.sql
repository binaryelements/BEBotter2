CREATE TABLE "memory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"owner_person_id" text,
	"department_id" text,
	"chat_id" text,
	"text" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"confidence" numeric(4, 2) DEFAULT '0.70' NOT NULL,
	"source" text DEFAULT 'taught' NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_bot_idx" ON "memory_items" USING btree ("tenant_id","definition_id","importance","last_used_at");--> statement-breakpoint
CREATE INDEX "memory_items_owner_idx" ON "memory_items" USING btree ("owner_person_id");--> statement-breakpoint
CREATE INDEX "memory_items_department_idx" ON "memory_items" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "memory_items_chat_idx" ON "memory_items" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "memory_items_search_idx" ON "memory_items" USING gin (to_tsvector('english', "text"));