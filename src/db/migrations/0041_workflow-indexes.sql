CREATE INDEX "workflow_pending_run_idx" ON "workflow_pending" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_run_events_run_idx" ON "workflow_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_due_idx" ON "workflow_runs" USING btree ("status","due_at");