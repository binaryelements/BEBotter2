CREATE TABLE "definition_tools" (
	"definition_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "definition_tools_definition_id_tool_name_pk" PRIMARY KEY("definition_id","tool_name")
);
--> statement-breakpoint
CREATE TABLE "tool_rules" (
	"definition_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"rule" text NOT NULL,
	CONSTRAINT "tool_rules_definition_id_tool_name_pk" PRIMARY KEY("definition_id","tool_name")
);
--> statement-breakpoint
ALTER TABLE "definition_tools" ADD CONSTRAINT "definition_tools_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_definition_id_bot_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."bot_definitions"("id") ON DELETE no action ON UPDATE no action;