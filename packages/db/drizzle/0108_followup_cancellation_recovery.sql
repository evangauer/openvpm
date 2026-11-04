ALTER TABLE "visit_closeouts" DROP CONSTRAINT "visit_closeouts_follow_up_resolution_check";--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_follow_up_resolution_check" CHECK ("visit_closeouts"."follow_up_resolved_at" is null
        and "visit_closeouts"."follow_up_resolution" is null
        and "visit_closeouts"."follow_up_resolution_appointment_id" is null
        and "visit_closeouts"."follow_up_resolution_scheduled_at" is null
        and "visit_closeouts"."follow_up_resolution_notes" is null
        and "visit_closeouts"."follow_up_resolved_by" is null
        and "visit_closeouts"."follow_up_resolver_name" is null
        or (
          "visit_closeouts"."follow_up_disposition" in ('needed', 'scheduled')
          and "visit_closeouts"."follow_up_resolved_at" is not null
          and "visit_closeouts"."follow_up_resolution" is not null
          and "visit_closeouts"."follow_up_resolved_by" is not null
          and length(btrim(coalesce("visit_closeouts"."follow_up_resolver_name", ''))) > 0
          and (
            "visit_closeouts"."follow_up_resolution" = 'scheduled'
            and "visit_closeouts"."follow_up_resolution_appointment_id" is not null
            and "visit_closeouts"."follow_up_resolution_scheduled_at" is not null
            or "visit_closeouts"."follow_up_resolution" in ('completed', 'not_needed')
            and "visit_closeouts"."follow_up_resolution_appointment_id" is null
            and "visit_closeouts"."follow_up_resolution_scheduled_at" is null
            and length(btrim(coalesce("visit_closeouts"."follow_up_resolution_notes", ''))) > 0
          )
        ));