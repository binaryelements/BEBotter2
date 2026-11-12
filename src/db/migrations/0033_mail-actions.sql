ALTER TABLE "bot_definitions" ADD COLUMN "mail_mode" text DEFAULT 'notify' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "mail_chat_id" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "mail_instruction" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "mail_by" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD CONSTRAINT "bot_definitions_mail_by_people_id_fk" FOREIGN KEY ("mail_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
