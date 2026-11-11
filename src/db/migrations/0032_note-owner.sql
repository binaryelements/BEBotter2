ALTER TABLE "knowledge_versions" ADD COLUMN "definition_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE set null ON UPDATE no action;
