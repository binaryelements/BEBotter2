ALTER TABLE "bot_definitions" ADD COLUMN "reflection_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "reflection_chat_id" text;--> statement-breakpoint
ALTER TABLE "bot_definitions" ADD COLUMN "reflection_hour" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "reflection_mode";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "reflection_chat_id";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "reflection_hour";