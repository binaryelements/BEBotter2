ALTER TABLE "sessions" ALTER COLUMN "sdk_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "messages" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model" text;