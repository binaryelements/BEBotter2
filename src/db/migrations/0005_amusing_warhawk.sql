CREATE TABLE "mailboxes" (
	"definition_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent" text NOT NULL,
	"inbox_id" text,
	"address" text,
	"key_id" text,
	"key_cipher" text,
	"webhook_id" text,
	"webhook_secret_cipher" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;