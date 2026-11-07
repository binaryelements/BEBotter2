CREATE TABLE "learning_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"owner_person_id" text,
	"reflection_id" text,
	"action" text NOT NULL,
	"learning_id" text,
	"text" text,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_person_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reflections" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"owner_person_id" text,
	"day" text NOT NULL,
	"summary" text NOT NULL,
	"went_well" text,
	"went_wrong" text,
	"corrections" text,
	"will_do" text,
	"model" text,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflections_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reflection_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reflection_chat_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reflection_hour" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_reflection_id_reflections_id_fk" FOREIGN KEY ("reflection_id") REFERENCES "public"."reflections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflections" ADD CONSTRAINT "reflections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflections" ADD CONSTRAINT "reflections_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflections" ADD CONSTRAINT "reflections_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;