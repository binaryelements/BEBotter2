CREATE TABLE "resource_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"cpu_pct" double precision NOT NULL,
	"mem_used" integer NOT NULL,
	"mem_total" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resource_samples_at_idx" ON "resource_samples" USING btree ("at");
