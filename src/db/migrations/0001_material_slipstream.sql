CREATE TABLE "definition_departments" (
	"definition_id" text NOT NULL,
	"department_id" text NOT NULL,
	CONSTRAINT "definition_departments_definition_id_department_id_pk" PRIMARY KEY("definition_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"department_id" text NOT NULL,
	"person_id" text NOT NULL,
	"is_head" boolean DEFAULT false NOT NULL,
	CONSTRAINT "department_members_department_id_person_id_pk" PRIMARY KEY("department_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "personal_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bot_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "definition_departments" ADD CONSTRAINT "definition_departments_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition_departments" ADD CONSTRAINT "definition_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;