ALTER TABLE "mailboxes" ADD COLUMN "local_part" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_local_part_unique" UNIQUE("local_part");