ALTER TABLE "connections" ADD COLUMN "owner_definition_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_definition_id_bot_definitions_id_fk" FOREIGN KEY ("owner_definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE cascade ON UPDATE no action;
