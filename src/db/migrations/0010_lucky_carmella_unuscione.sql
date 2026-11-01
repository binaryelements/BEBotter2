ALTER TABLE "bot_definitions" ADD COLUMN "identity" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "graph" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "owner_person_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;