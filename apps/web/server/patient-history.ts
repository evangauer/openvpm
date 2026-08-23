import { sql, type SQL } from "drizzle-orm";
import {
  clinicalRecordCorrections,
  labResultReplacements,
  labResults,
  patientAllergies,
  patients,
  practices,
  prescriptions,
  problemList,
  procedures,
  soapNoteAddenda,
  soapNoteReplacements,
  soapNotes,
  users,
  vaccinationRecords,
  vitalSigns,
} from "@openpims/db";
import {
  patientHistoryContainsPattern,
  type PatientHistoryRecordType,
  type PatientHistoryStateFilter,
} from "@/lib/records/patient-history";

export type PatientHistoryCursor = {
  occurredAt: string;
  recordType: PatientHistoryRecordType;
  id: string;
};

export type PatientHistoryQuery = {
  patientId: string;
  query?: string;
  recordTypes: PatientHistoryRecordType[];
  state: PatientHistoryStateFilter;
  fromDate?: string;
  toDate?: string;
  cursor?: PatientHistoryCursor;
  limit: number;
};

export type PatientHistoryRawRow = {
  id: string | null;
  recordType: PatientHistoryRecordType | null;
  displayDate: string | null;
  occurredAt: Date | string | null;
  title: string | null;
  summary: string | null;
  status: string | null;
  corrected: boolean | null;
  imported: boolean | null;
  replacesRecordId: string | null;
  replacementRecordId: string | null;
  authorLabel: string | null;
  authorName: string | null;
  finalizerName: string | null;
  totalCount: number;
};

const noRecordId = sql`null::uuid`;
const noText = sql`null::text`;

/**
 * SOAP sections and addenda are stored as sanitized rich text. Search and
 * excerpts must operate on what a clinician sees, never HTML tag names or a
 * prefix that can omit a late literal match.
 */
function visibleClinicalText(value: SQL): SQL {
  return sql`btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                coalesce(${value}::text, ''),
                '<[^>]*>', ' ', 'g'
              ),
              '&nbsp;|&#160;', ' ', 'gi'
            ),
            '&amp;', '&', 'gi'
          ),
          '&quot;', '"', 'gi'
        ),
        '&apos;|&#39;', '''', 'gi'
      ),
      '&lt;', '<', 'gi'
    ),
    '[[:space:]]+', ' ', 'g'
  ))`;
}

function labeledClinicalText(label: string, value: SQL): SQL {
  const visible = visibleClinicalText(value);
  return sql`case
    when nullif(${visible}, '') is not null then concat(${label}::text, ': ', ${visible})
  end`;
}

/**
 * Explicit allowlisted projection of client-exportable clinical chart data.
 * Deliberately absent: clinical_notes, communications, appointment notes,
 * worklists, documents, invoices, and every operational/private surface.
 */
export function buildPatientHistoryQuery(args: {
  practiceId: string;
  input: PatientHistoryQuery;
}): SQL<PatientHistoryRawRow> {
  const { practiceId, input } = args;
  const recordTypes = sql.join(
    input.recordTypes.map((recordType) => sql`${recordType}`),
    sql`, `,
  );
  const includes = (recordType: PatientHistoryRecordType) =>
    input.recordTypes.includes(recordType) ? sql`true` : sql`false`;
  const query = input.query?.trim();
  const searchPattern = query ? patientHistoryContainsPattern(query) : null;
  const textPredicate = searchPattern
    ? sql`history.search_text ilike ${searchPattern} escape '\\'`
    : sql`true`;
  const statePredicate =
    input.state === "current"
      ? sql`history.corrected = false`
      : input.state === "corrected"
        ? sql`history.corrected = true`
        : sql`true`;
  const fromPredicate = input.fromDate
    ? sql`history.occurred_date >= ${input.fromDate}`
    : sql`true`;
  const toPredicate = input.toDate
    ? sql`history.occurred_date <= ${input.toDate}`
    : sql`true`;
  const cursorPredicate = input.cursor
    ? sql`(matched.occurred_at, matched.record_type, matched.id) <
        (${input.cursor.occurredAt}::timestamptz, ${input.cursor.recordType}, ${input.cursor.id}::uuid)`
    : sql`true`;

  return sql<PatientHistoryRawRow>`
    with practice_context as materialized (
      select
        ${practices.id} as practice_id,
        coalesce(nullif(btrim(${practices.timezone}), ''), 'UTC') as time_zone
      from ${practices}
      where ${practices.id} = ${practiceId}
        and ${practices.deletedAt} is null
    ), history as materialized (
      select
        soap.id,
        'soap_note'::text as record_type,
        soap.created_at as occurred_at,
        to_char(timezone(practice.time_zone, soap.created_at), 'YYYY-MM-DD') as occurred_date,
        soap.created_at::text as display_date,
        'SOAP note'::text as title,
        soap.status::text as status,
        correction.id is not null as corrected,
        soap.imported as imported,
        source_link.source_soap_note_id as replaces_record_id,
        replacement_link.replacement_soap_note_id as replacement_record_id,
        case when soap.imported then 'Imported by' else 'Authored by' end as author_label,
        soap.author_name::text as author_name,
        soap.finalizer_name::text as finalizer_name,
        concat_ws(
          E'\n',
          ${labeledClinicalText("Subjective", sql`soap.subjective`)},
          ${labeledClinicalText("Objective", sql`soap.objective`)},
          ${labeledClinicalText("Assessment", sql`soap.assessment`)},
          ${labeledClinicalText("Plan", sql`soap.plan`)},
          ${labeledClinicalText("Addendum", sql`addenda.content`)},
          case when nullif(correction.reason, '') is not null
            then concat('Correction: ', correction.reason)
          end
        ) as search_text
      from ${soapNotes} soap
      join practice_context practice on practice.practice_id = soap.practice_id
      left join ${clinicalRecordCorrections} correction
        on correction.practice_id = soap.practice_id
       and correction.soap_note_id = soap.id
      left join ${soapNoteReplacements} source_link
        on source_link.practice_id = soap.practice_id
       and source_link.replacement_soap_note_id = soap.id
      left join ${soapNoteReplacements} replacement_link
        on replacement_link.practice_id = soap.practice_id
       and replacement_link.source_soap_note_id = soap.id
      left join lateral (
        select string_agg(
          ${visibleClinicalText(sql`addendum.content`)},
          E'\n' order by addendum.created_at, addendum.id
        ) as content
        from ${soapNoteAddenda} addendum
        where addendum.practice_id = soap.practice_id
          and addendum.soap_note_id = soap.id
      ) addenda on true
      where soap.practice_id = ${practiceId}
        and soap.patient_id = ${input.patientId}
        and soap.status = 'finalized'
        and soap.deleted_at is null
        and ${includes("soap_note")}

      union all

      select
        prescription.id,
        'prescription'::text,
        prescription.start_date::timestamp at time zone practice.time_zone,
        prescription.start_date::text,
        prescription.start_date::text,
        prescription.medication_name::text,
        case
          when prescription.status = 'active'
            and prescription.end_date is not null
            and prescription.end_date < (now() at time zone practice.time_zone)::date
          then 'expired'
          else prescription.status::text
        end,
        false,
        false,
        ${noRecordId},
        ${noRecordId},
        'Prescribed by'::text,
        prescriber.name::text,
        ${noText},
        concat_ws(
          E'\n',
          prescription.medication_name,
          prescription.dosage,
          prescription.frequency,
          prescription.instructions,
          prescription.quantity::text,
          prescription.refills_remaining::text
        )
      from ${prescriptions} prescription
      join practice_context practice on practice.practice_id = prescription.practice_id
      left join ${users} prescriber
        on prescriber.practice_id = prescription.practice_id
       and prescriber.id = prescription.prescribed_by
      where prescription.practice_id = ${practiceId}
        and prescription.patient_id = ${input.patientId}
        and prescription.deleted_at is null
        and ${includes("prescription")}

      union all

      select
        vaccination.id,
        'vaccination'::text,
        vaccination.administered_at,
        to_char(timezone(practice.time_zone, vaccination.administered_at), 'YYYY-MM-DD'),
        vaccination.administered_at::text,
        vaccination.vaccine_name::text,
        'recorded'::text,
        correction.id is not null,
        vaccination.import_fingerprint is not null,
        ${noRecordId},
        ${noRecordId},
        'Administered by'::text,
        administrator.name::text,
        ${noText},
        concat_ws(
          E'\n',
          vaccination.vaccine_name,
          vaccination.manufacturer,
          vaccination.lot_number,
          vaccination.next_due_date::text,
          correction.reason
        )
      from ${vaccinationRecords} vaccination
      join practice_context practice on practice.practice_id = vaccination.practice_id
      left join ${clinicalRecordCorrections} correction
        on correction.practice_id = vaccination.practice_id
       and correction.vaccination_record_id = vaccination.id
      left join ${users} administrator
        on administrator.practice_id = vaccination.practice_id
       and administrator.id = vaccination.administered_by
      where vaccination.practice_id = ${practiceId}
        and vaccination.patient_id = ${input.patientId}
        and vaccination.deleted_at is null
        and ${includes("vaccination")}

      union all

      select
        lab.id,
        'lab_result'::text,
        coalesce(lab.completed_at, lab.created_at),
        to_char(timezone(practice.time_zone, coalesce(lab.completed_at, lab.created_at)), 'YYYY-MM-DD'),
        coalesce(lab.completed_at, lab.created_at)::text,
        lab.test_name::text,
        lab.status::text,
        correction.id is not null,
        false,
        source_link.source_lab_result_id,
        replacement_link.replacement_lab_result_id,
        'Ordered by'::text,
        ordered_by.name::text,
        ${noText},
        concat_ws(
          E'\n',
          lab.test_name,
          lab.result_value,
          lab.unit,
          lab.reference_range_low::text,
          lab.reference_range_high::text,
          lab.result_flag::text,
          correction.reason
        )
      from ${labResults} lab
      join practice_context practice on practice.practice_id = lab.practice_id
      left join ${clinicalRecordCorrections} correction
        on correction.practice_id = lab.practice_id
       and correction.lab_result_id = lab.id
      left join ${labResultReplacements} source_link
        on source_link.practice_id = lab.practice_id
       and source_link.replacement_lab_result_id = lab.id
      left join ${labResultReplacements} replacement_link
        on replacement_link.practice_id = lab.practice_id
       and replacement_link.source_lab_result_id = lab.id
      left join ${users} ordered_by
        on ordered_by.practice_id = lab.practice_id
       and ordered_by.id = lab.ordered_by
      where lab.practice_id = ${practiceId}
        and lab.patient_id = ${input.patientId}
        and lab.deleted_at is null
        and ${includes("lab_result")}

      union all

      select
        procedure.id,
        'procedure'::text,
        procedure.created_at,
        to_char(timezone(practice.time_zone, procedure.created_at), 'YYYY-MM-DD'),
        procedure.created_at::text,
        procedure.name::text,
        'completed'::text,
        false,
        false,
        ${noRecordId},
        ${noRecordId},
        'Performed by'::text,
        performer.name::text,
        ${noText},
        concat_ws(
          E'\n',
          procedure.name,
          procedure.description,
          procedure.anesthesia_used,
          procedure.duration_minutes::text,
          procedure.notes
        )
      from ${procedures} procedure
      join practice_context practice on practice.practice_id = procedure.practice_id
      left join ${users} performer
        on performer.practice_id = procedure.practice_id
       and performer.id = procedure.performed_by
      where procedure.practice_id = ${practiceId}
        and procedure.patient_id = ${input.patientId}
        and procedure.deleted_at is null
        and ${includes("procedure")}

      union all

      select
        problem.id,
        'problem'::text,
        coalesce(
          problem.onset_date::timestamp at time zone practice.time_zone,
          problem.created_at
        ),
        coalesce(
          problem.onset_date::text,
          to_char(timezone(practice.time_zone, problem.created_at), 'YYYY-MM-DD')
        ),
        coalesce(problem.onset_date::text, problem.created_at::text),
        problem.description::text,
        problem.status::text,
        false,
        false,
        ${noRecordId},
        ${noRecordId},
        ${noText},
        null::text,
        ${noText},
        concat_ws(E'\n', problem.description, problem.status::text, problem.resolved_date::text)
      from ${problemList} problem
      join practice_context practice on practice.practice_id = problem.practice_id
      where problem.practice_id = ${practiceId}
        and problem.patient_id = ${input.patientId}
        and problem.deleted_at is null
        and ${includes("problem")}

      union all

      select
        vital.id,
        'vital_sign'::text,
        vital.recorded_at,
        to_char(timezone(practice.time_zone, vital.recorded_at), 'YYYY-MM-DD'),
        vital.recorded_at::text,
        'Vital signs'::text,
        'recorded'::text,
        correction.id is not null,
        false,
        ${noRecordId},
        ${noRecordId},
        'Recorded by'::text,
        recorder.name::text,
        ${noText},
        concat_ws(
          E'\n',
          vital.temperature_c::text,
          vital.heart_rate_bpm::text,
          vital.respiratory_rate_bpm::text,
          vital.weight_kg::text,
          vital.body_condition_score::text,
          vital.pain_score::text,
          vital.mucous_membrane,
          vital.capillary_refill_sec::text,
          vital.notes,
          correction.reason
        )
      from ${vitalSigns} vital
      join practice_context practice on practice.practice_id = vital.practice_id
      left join ${clinicalRecordCorrections} correction
        on correction.practice_id = vital.practice_id
       and correction.vital_sign_id = vital.id
      left join ${users} recorder
        on recorder.practice_id = vital.practice_id
       and recorder.id = vital.recorded_by
      where vital.practice_id = ${practiceId}
        and vital.patient_id = ${input.patientId}
        and vital.deleted_at is null
        and ${includes("vital_sign")}

      union all

      select
        allergy.id,
        'allergy'::text,
        allergy.noted_at,
        to_char(timezone(practice.time_zone, allergy.noted_at), 'YYYY-MM-DD'),
        allergy.noted_at::text,
        allergy.allergen::text,
        allergy.severity::text,
        correction.id is not null,
        false,
        ${noRecordId},
        ${noRecordId},
        'Recorded by'::text,
        recorder.name::text,
        ${noText},
        concat_ws(E'\n', allergy.allergen, allergy.reaction, allergy.severity::text, correction.reason)
      from ${patientAllergies} allergy
      join ${patients} patient
        on patient.id = allergy.patient_id
       and patient.practice_id = ${practiceId}
       and patient.deleted_at is null
      join practice_context practice on practice.practice_id = patient.practice_id
      left join ${clinicalRecordCorrections} correction
        on correction.practice_id = patient.practice_id
       and correction.patient_allergy_id = allergy.id
      left join ${users} recorder
        on recorder.practice_id = patient.practice_id
       and recorder.id = allergy.noted_by
      where allergy.patient_id = ${input.patientId}
        and allergy.deleted_at is null
        and ${includes("allergy")}
    ), matched as materialized (
      select history.*
      from history
      where history.record_type in (${recordTypes})
        and ${textPredicate}
        and ${statePredicate}
        and ${fromPredicate}
        and ${toPredicate}
    )
    select
      page.id,
      page.record_type as "recordType",
      page.display_date as "displayDate",
      page.occurred_at as "occurredAt",
      page.title,
      case
        when ${searchPattern}::text is null then left(page.search_text, 500)
        else coalesce((
          select left(
            string_agg(
              substring(
                match.line
                from greatest(strpos(lower(match.line), lower(${query ?? ""})) - 80, 1)
                for 200
              ),
              E'\n' order by match.position
            ),
            500
          )
          from (
            select candidate.line, candidate.position
            from unnest(string_to_array(page.search_text, E'\n'))
              with ordinality as candidate(line, position)
            where candidate.line ilike ${searchPattern ?? ""} escape '\\'
            order by candidate.position
            limit 3
          ) match
        ), '')
      end as summary,
      page.status,
      page.corrected,
      page.imported,
      page.replaces_record_id as "replacesRecordId",
      page.replacement_record_id as "replacementRecordId",
      page.author_label as "authorLabel",
      page.author_name as "authorName",
      page.finalizer_name as "finalizerName",
      totals.total_count as "totalCount"
    from (select count(*)::int as total_count from matched) totals
    left join lateral (
      select matched.*
      from matched
      where ${cursorPredicate}
      order by matched.occurred_at desc, matched.record_type desc, matched.id desc
      limit ${input.limit + 1}
    ) page on true
    order by page.occurred_at desc, page.record_type desc, page.id desc
  `;
}
