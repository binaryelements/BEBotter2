CREATE TABLE "connection_grants" (
	"definition_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grants_definition_id_connection_id_pk" PRIMARY KEY("definition_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;