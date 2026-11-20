CREATE TABLE "call_handovers" (
	"definition_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"target" text NOT NULL,
	"then_target" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_handovers_definition_id_connection_id_pk" PRIMARY KEY("definition_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "call_handovers" ADD CONSTRAINT "call_handovers_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_handovers" ADD CONSTRAINT "call_handovers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;
