ALTER TABLE "learning_proposals" DROP CONSTRAINT "learning_proposals_reflection_id_reflections_id_fk";
--> statement-breakpoint
ALTER TABLE "learning_proposals" DROP CONSTRAINT "learning_proposals_learning_id_learnings_id_fk";
--> statement-breakpoint
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE set null ON UPDATE no action;