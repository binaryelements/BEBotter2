ALTER TABLE "bot_definitions" ADD COLUMN "inbound_secret" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "inbound_chat_id" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "inbound_by" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "inbound_hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD CONSTRAINT "bot_definitions_inbound_by_people_id_fk" FOREIGN KEY ("inbound_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;
