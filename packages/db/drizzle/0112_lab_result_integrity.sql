DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public.lab_result_replacements link
		JOIN public.lab_results source
			ON source.practice_id = link.practice_id
			AND source.id = link.source_lab_result_id
		JOIN public.lab_results replacement
			ON replacement.practice_id = link.practice_id
			AND replacement.id = link.replacement_lab_result_id
		WHERE source.patient_id IS DISTINCT FROM replacement.patient_id
			OR source.appointment_id IS DISTINCT FROM replacement.appointment_id
	) THEN
		RAISE EXCEPTION 'Lab result integrity migration blocked: replacement lineage crosses a patient or appointment chart';
	END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_lab_result_replacement_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	correction_matches boolean := false;
	chart_matches boolean := false;
	cycle_exists boolean := false;
BEGIN
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('lab-result-replacement-graph:' || NEW.practice_id::text, 0)
	);
	SELECT EXISTS (
		SELECT 1 FROM public.clinical_record_corrections correction
		WHERE correction.practice_id = NEW.practice_id
			AND correction.id = NEW.correction_id
			AND correction.record_type = 'lab_result'
			AND correction.lab_result_id = NEW.source_lab_result_id
	) INTO correction_matches;
	IF NOT correction_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Replacement must identify the exact entered-in-error lab correction for its source.';
	END IF;
	SELECT EXISTS (
		SELECT 1
		FROM public.lab_results source
		JOIN public.lab_results replacement
			ON replacement.practice_id = source.practice_id
			AND replacement.id = NEW.replacement_lab_result_id
		WHERE source.practice_id = NEW.practice_id
			AND source.id = NEW.source_lab_result_id
			AND source.patient_id = replacement.patient_id
			AND source.appointment_id IS NOT DISTINCT FROM replacement.appointment_id
	) INTO chart_matches;
	IF NOT chart_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lab result replacement must remain in the source patient and appointment chart.';
	END IF;
	WITH RECURSIVE descendants(id) AS (
		SELECT link.replacement_lab_result_id
		FROM public.lab_result_replacements link
		WHERE link.practice_id = NEW.practice_id AND link.source_lab_result_id = NEW.replacement_lab_result_id
		UNION
		SELECT link.replacement_lab_result_id
		FROM public.lab_result_replacements link
		JOIN descendants prior ON prior.id = link.source_lab_result_id
		WHERE link.practice_id = NEW.practice_id
	)
	SELECT EXISTS (SELECT 1 FROM descendants WHERE id = NEW.source_lab_result_id) INTO cycle_exists;
	IF cycle_exists THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lab result replacement lineage cannot contain a cycle.';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON lab_results FROM openpims_app;
		GRANT SELECT, INSERT ON lab_results TO openpims_app;
		GRANT UPDATE (
			status, result_value, unit, reference_range_low, reference_range_high,
			result_flag, completed_at, reviewed_by, reviewed_at, follow_up_status,
			follow_up_assigned_to, follow_up_due_at, follow_up_note,
			follow_up_completed_by, follow_up_completed_at, follow_up_outcome,
			updated_at
		) ON lab_results TO openpims_app;
	END IF;
END $$;
