import { z } from "zod";
import {
  eq,
  and,
  isNull,
  or,
  ilike,
  gte,
  lte,
  lt,
  desc,
  asc,
  inArray,
  not,
  gt,
  sql,
} from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  clients,
  patients,
  appointments,
  vitalSigns,
  vaccinationRecords,
  problemList,
  treatmentPlans,
  treatmentPlanItems,
  users,
  rooms,
  locations,
  practices,
  clinicalRecordCorrections,
} from "@openpims/db";
import {
  appointmentCreatedWebhookPayload,
  dispatchAppointmentWebhookAfterCommit,
} from "@/lib/appointment-webhooks";
import { recordActivationAfterAppointmentCreated } from "@/lib/funnel-events-server";
import {
  dateInputTimeUtcInstant,
  formatDateInputForTimeZone,
} from "@/lib/date-input";
import {
  FORMULARY,
  DOSING_WEIGHT_MAX_KG,
  FORMULARY_DRUG_ID_MAX_LENGTH,
  calculateDose,
  isFormularyDrugId,
} from "@/lib/dosing";
import {
  summarizePlanProgress,
  type PlanItemStatus,
} from "@/lib/treatment-plans/progress";
import { findOpenSlots } from "@/lib/scheduling/availability";
import {
  conflictMessage,
  detectConflicts,
  type ExistingBooking,
} from "@/lib/scheduling/conflicts";
import {
  clinicalDecimalInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  listActiveAppointmentLocations,
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "@/lib/scheduling/location";

/**
 * The agent's "hands": typed tools that operate the practice's data, always
 * scoped to a single practiceId. Each tool carries a JSON schema (for the
 * model) and a Zod schema (for runtime validation). Read tools are safe to
 * auto-run; write tools are flagged so the runner can gate them.
 */
export interface AgentToolContext {
  db: Database;
  practiceId: string;
  userId: string;
  postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema sent to the model as the tool's input_schema. */
  inputSchema: Record<string, unknown>;
  /** Runtime validation of the model-supplied args. */
  zod: z.ZodTypeAny;
  readOnly: boolean;
  requiredApiScopes?: AgentWriteApiScope[];
  execute(args: unknown, ctx: AgentToolContext): Promise<unknown>;
}

export type AgentWriteApiScope = "appointments:write" | "records:write";

export class AgentPracticeNotFoundError extends Error {
  constructor() {
    super("Practice not found");
    this.name = "AgentPracticeNotFoundError";
  }
}

export const AGENT_SEARCH_QUERY_MAX_LENGTH = 100;
export const AGENT_NOTES_MAX_LENGTH = 2000;
const FORMULARY_DRUG_IDS = FORMULARY.map((drug) => drug.id);

const agentSearchQueryInput = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_SEARCH_QUERY_MAX_LENGTH);

const agentOptionalNotesInput = z
  .string()
  .trim()
  .max(AGENT_NOTES_MAX_LENGTH)
  .optional();

const formularyDrugIdInput = z
  .string()
  .trim()
  .min(1)
  .max(FORMULARY_DRUG_ID_MAX_LENGTH)
  .refine(isFormularyDrugId, "Drug must be in the formulary.");

const vitalTemperatureInput = clinicalDecimalInput("Temperature", {
  min: 20,
  max: 45,
  scale: 1,
});
const vitalWeightInput = clinicalDecimalInput("Weight", { positive: true, max: 200, scale: 3 });
const vitalCapillaryRefillInput = clinicalDecimalInput("Capillary refill", {
  min: 0,
  max: 10,
  scale: 1,
});

async function practiceTimeZone(
  ctx: AgentToolContext
): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new AgentPracticeNotFoundError();
  }
  return practice.timezone ?? null;
}

async function practiceDateInput(ctx: AgentToolContext): Promise<string> {
  const timezone = await practiceTimeZone(ctx);
  return formatDateInputForTimeZone(new Date(), timezone);
}

function clientName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ");
}

async function activeClientExists(
  ctx: AgentToolContext,
  clientId: string
): Promise<boolean> {
  const [client] = await ctx.db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.practiceId, ctx.practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);
  return Boolean(client);
}

async function activePatient(
  ctx: AgentToolContext,
  patientId: string
): Promise<{ id: string; clientId: string } | null> {
  const [patient] = await ctx.db
    .select({ id: patients.id, clientId: patients.clientId })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);
  return patient ?? null;
}

async function activeDoctorExists(
  ctx: AgentToolContext,
  doctorId: string
): Promise<boolean> {
  const [doctor] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, doctorId),
        eq(users.practiceId, ctx.practiceId),
        eq(users.isVeterinarian, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  return Boolean(doctor);
}

async function activeRoomExists(
  ctx: AgentToolContext,
  roomId: string
): Promise<boolean> {
  const [room] = await ctx.db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.practiceId, ctx.practiceId),
        isNull(rooms.deletedAt)
      )
    )
    .limit(1);
  return Boolean(room);
}

async function validateScheduleResources(
  ctx: AgentToolContext,
  input: { doctorId?: string; roomId?: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.doctorId && !(await activeDoctorExists(ctx, input.doctorId))) {
    return { ok: false, error: "Doctor not found" };
  }

  if (input.roomId && !(await activeRoomExists(ctx, input.roomId))) {
    return { ok: false, error: "Room not found" };
  }

  return { ok: true };
}

async function validateAppointmentTargets(
  ctx: AgentToolContext,
  input: { clientId?: string; patientId?: string; doctorId?: string }
): Promise<
  | { ok: true; clientId: string | null }
  | { ok: false; error: string }
> {
  let patientClientId: string | undefined;
  if (input.patientId) {
    const patient = await activePatient(ctx, input.patientId);
    if (!patient) return { ok: false, error: "Patient not found" };
    patientClientId = patient.clientId;
  }

  if (input.clientId && patientClientId && input.clientId !== patientClientId) {
    return { ok: false, error: "Patient not found" };
  }

  const clientId = input.clientId ?? patientClientId;
  if (clientId && !(await activeClientExists(ctx, clientId))) {
    return { ok: false, error: "Client not found" };
  }

  const resources = await validateScheduleResources(ctx, {
    doctorId: input.doctorId,
  });
  if (!resources.ok) return resources;

  return { ok: true, clientId: clientId ?? null };
}

async function fetchOverlappingAppointments(
  ctx: AgentToolContext,
  startTime: Date,
  endTime: Date
): Promise<ExistingBooking[]> {
  return ctx.db
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      doctorId: appointments.doctorId,
      roomId: appointments.roomId,
      locationId: appointments.locationId,
      status: appointments.status,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.practiceId, ctx.practiceId),
        isNull(appointments.deletedAt),
        not(inArray(appointments.status, ["cancelled", "no_show"])),
        lt(appointments.startTime, endTime),
        gt(appointments.endTime, startTime)
      )
    );
}

const findClient: AgentTool = {
  name: "find_client",
  description:
    "Search clients (pet owners) by name, email, or phone. Returns up to 10 matches with their ids.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Name, email, or phone fragment" } },
    required: ["query"],
  },
  zod: z.object({ query: agentSearchQueryInput }),
  readOnly: true,
  async execute(args, ctx) {
    const { query } = this.zod.parse(args) as { query: string };
    const rows = await ctx.db
      .select({
        id: clients.id,
        firstName: clients.firstName,
        lastName: clients.lastName,
        email: clients.email,
        phone: clients.phone,
      })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
          or(
            ilike(clients.firstName, `%${query}%`),
            ilike(clients.lastName, `%${query}%`),
            ilike(clients.email, `%${query}%`),
            ilike(clients.phone, `%${query}%`)
          )
        )
      )
      .limit(10);
    return rows;
  },
};

const getPatientSummary: AgentTool = {
  name: "get_patient_summary",
  description:
    "Get a clinical summary for a patient: signalment, latest vitals, vaccinations, and active problems.",
  inputSchema: {
    type: "object",
    properties: { patientId: { type: "string", description: "Patient UUID" } },
    required: ["patientId"],
  },
  zod: z.object({ patientId: z.string().uuid() }),
  readOnly: true,
  async execute(args, ctx) {
    const { patientId } = this.zod.parse(args) as { patientId: string };
    const scope = and(eq(patients.practiceId, ctx.practiceId), isNull(patients.deletedAt));

    const [patient] = await ctx.db
      .select()
      .from(patients)
      .where(and(eq(patients.id, patientId), scope))
      .limit(1);
    if (!patient) return { error: "Patient not found" };

    const [latestVitals, vaccinations, problems] = await Promise.all([
      ctx.db
        .select()
        .from(vitalSigns)
        .where(
          and(
            eq(vitalSigns.patientId, patientId),
            eq(vitalSigns.practiceId, ctx.practiceId),
            isNull(vitalSigns.deletedAt),
            sql`not exists (
              select 1
              from ${clinicalRecordCorrections}
              where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId}
                and ${clinicalRecordCorrections.vitalSignId} = ${vitalSigns.id}
            )`
          )
        )
        .orderBy(desc(vitalSigns.recordedAt))
        .limit(1),
      ctx.db
        .select({
          vaccineName: vaccinationRecords.vaccineName,
          administeredAt: vaccinationRecords.administeredAt,
          nextDueDate: vaccinationRecords.nextDueDate,
        })
        .from(vaccinationRecords)
        .where(
          and(
            eq(vaccinationRecords.patientId, patientId),
            eq(vaccinationRecords.practiceId, ctx.practiceId),
            isNull(vaccinationRecords.deletedAt),
            sql`not exists (
              select 1
              from ${clinicalRecordCorrections}
              where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId}
                and ${clinicalRecordCorrections.vaccinationRecordId} = ${vaccinationRecords.id}
            )`
          )
        ),
      ctx.db
        .select({ description: problemList.description, status: problemList.status })
        .from(problemList)
        .where(
          and(
            eq(problemList.patientId, patientId),
            eq(problemList.practiceId, ctx.practiceId),
            isNull(problemList.deletedAt),
            eq(problemList.status, "active")
          )
        ),
    ]);

    return {
      patient: {
        id: patient.id,
        name: patient.name,
        species: patient.species,
        breed: patient.breed,
        sex: patient.sex,
        dob: patient.dob,
        status: patient.status,
      },
      latestVitals: latestVitals[0] ?? null,
      vaccinations,
      activeProblems: problems,
    };
  },
};

const listLocations: AgentTool = {
  name: "list_locations",
  description:
    "List active clinic locations. Use the location id when finding slots or booking in a multi-location practice.",
  inputSchema: { type: "object", properties: {} },
  zod: z.object({}),
  readOnly: true,
  async execute(_args, ctx) {
    return listActiveAppointmentLocations(ctx.db, ctx.practiceId);
  },
};

const listAppointments: AgentTool = {
  name: "list_appointments",
  description: "List appointments within a date range (inclusive). Dates are ISO-8601.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "ISO start datetime" },
      endDate: { type: "string", description: "ISO end datetime" },
    },
    required: ["startDate", "endDate"],
  },
  zod: z.object({
    startDate: z.string().datetime({ offset: true }),
    endDate: z.string().datetime({ offset: true }),
  }),
  readOnly: true,
  async execute(args, ctx) {
    const { startDate, endDate } = this.zod.parse(args) as {
      startDate: string;
      endDate: string;
    };
    const rows = await ctx.db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        locationId: appointments.locationId,
        locationName: locations.name,
        patientName: patients.name,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
      })
      .from(appointments)
      .leftJoin(
        locations,
        and(
          eq(appointments.locationId, locations.id),
          eq(locations.practiceId, ctx.practiceId),
        ),
      )
      .leftJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.clientId, appointments.clientId),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, new Date(startDate)),
          lte(appointments.startTime, new Date(endDate))
        )
      )
      .orderBy(appointments.startTime);
    return rows.map((r) => ({
      id: r.id,
      startTime: r.startTime,
      endTime: r.endTime,
      status: r.status,
      locationId: r.locationId,
      location: r.locationName,
      patient: r.patientName,
      client: clientName(r.clientFirst, r.clientLast),
    }));
  },
};

const bookAppointment: AgentTool = {
  name: "book_appointment",
  description:
    "Create an appointment. Times are ISO-8601; end must be after start. client_id and patient_id are optional but recommended.",
  inputSchema: {
    type: "object",
    properties: {
      startTime: { type: "string" },
      endTime: { type: "string" },
      clientId: { type: "string" },
      patientId: { type: "string" },
      doctorId: { type: "string" },
      roomId: { type: "string" },
      locationId: { type: "string" },
      notes: { type: "string" },
    },
    required: ["startTime", "endTime"],
  },
  zod: z
    .object({
      startTime: z.string().datetime({ offset: true }),
      endTime: z.string().datetime({ offset: true }),
      clientId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      doctorId: z.string().uuid().optional(),
      roomId: z.string().uuid().optional(),
      locationId: z.string().uuid().optional(),
      notes: agentOptionalNotesInput,
    })
    .refine((b) => new Date(b.endTime) > new Date(b.startTime), {
      message: "endTime must be after startTime",
    }),
  readOnly: false,
  requiredApiScopes: ["appointments:write"],
  async execute(args, ctx) {
    const input = this.zod.parse(args) as {
      startTime: string;
      endTime: string;
      clientId?: string;
      patientId?: string;
      doctorId?: string;
      roomId?: string;
      locationId?: string;
      notes?: string;
    };
    await takeAppointmentSchedulingLock(ctx.db, ctx.practiceId);
    const targets = await validateAppointmentTargets(ctx, input);
    if (!targets.ok) return { error: targets.error };
    const location = await resolveAppointmentLocation(ctx.db, {
      practiceId: ctx.practiceId,
      locationId: input.locationId,
      doctorId: input.doctorId,
      roomId: input.roomId,
    });
    if (!location.ok) return { error: location.message };

    const startTime = new Date(input.startTime);
    const endTime = new Date(input.endTime);
    const message = conflictMessage(
      detectConflicts(
        {
          startTime,
          endTime,
          doctorId: input.doctorId,
          roomId: input.roomId,
          locationId: location.locationId,
        },
        await fetchOverlappingAppointments(ctx, startTime, endTime)
      )
    );
    if (message) return { error: message };

    const [created] = await ctx.db
      .insert(appointments)
      .values({
        practiceId: ctx.practiceId,
        startTime,
        endTime,
        clientId: targets.clientId,
        patientId: input.patientId ?? null,
        doctorId: input.doctorId ?? null,
        roomId: input.roomId ?? null,
        locationId: location.locationId,
        notes: input.notes ?? null,
      })
      .returning();
    await recordActivationAfterAppointmentCreated(
      ctx.db,
      ctx.practiceId,
      "agent.book_appointment"
    );
    await dispatchAppointmentWebhookAfterCommit(
      ctx,
      ctx.practiceId,
      "appointment.created",
      appointmentCreatedWebhookPayload(created!, "agent")
    );
    return { id: created!.id, status: created!.status };
  },
};

const listOverdueVaccinations: AgentTool = {
  name: "list_overdue_vaccinations",
  description: "List patients whose vaccinations are past due, for recall outreach.",
  inputSchema: { type: "object", properties: {} },
  zod: z.object({}),
  readOnly: true,
  async execute(_args, ctx) {
    const today = await practiceDateInput(ctx);
    const rows = await ctx.db
      .select({
        patientId: patients.id,
        patientName: patients.name,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
        vaccineName: vaccinationRecords.vaccineName,
        nextDueDate: vaccinationRecords.nextDueDate,
      })
      .from(vaccinationRecords)
      .innerJoin(
        patients,
        and(
          eq(vaccinationRecords.patientId, patients.id),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(vaccinationRecords.practiceId, ctx.practiceId),
          isNull(vaccinationRecords.deletedAt),
          sql`not exists (
            select 1
            from ${clinicalRecordCorrections}
            where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId}
              and ${clinicalRecordCorrections.vaccinationRecordId} = ${vaccinationRecords.id}
          )`,
          sql`not exists (
            select 1
            from vaccination_records as newer_vaccination
            where newer_vaccination.practice_id = ${ctx.practiceId}
              and newer_vaccination.patient_id = ${vaccinationRecords.patientId}
              and newer_vaccination.deleted_at is null
              and lower(btrim(newer_vaccination.vaccine_name)) = lower(btrim(${vaccinationRecords.vaccineName}))
              and not exists (
                select 1
                from clinical_record_corrections as newer_correction
                where newer_correction.practice_id = ${ctx.practiceId}
                  and newer_correction.vaccination_record_id = newer_vaccination.id
              )
              and (
                newer_vaccination.administered_at > ${vaccinationRecords.administeredAt}
                or (
                  newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
                  and newer_vaccination.created_at > ${vaccinationRecords.createdAt}
                )
                or (
                  newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
                  and newer_vaccination.created_at = ${vaccinationRecords.createdAt}
                  and newer_vaccination.id::text > ${vaccinationRecords.id}::text
                )
              )
          )`,
          isNull(patients.deletedAt),
          lt(vaccinationRecords.nextDueDate, today)
        )
      )
      .orderBy(vaccinationRecords.nextDueDate)
      .limit(100);
    return rows.map((r) => ({
      patientId: r.patientId,
      patient: r.patientName,
      client: clientName(r.clientFirst, r.clientLast),
      vaccine: r.vaccineName,
      dueDate: r.nextDueDate,
    }));
  },
};

const calculateDrugDose: AgentTool = {
  name: "calculate_drug_dose",
  description:
    "Calculate a weight-based drug dose from the formulary. Returns a reference range; the clinician must verify before prescribing.",
  inputSchema: {
    type: "object",
    properties: {
      drugId: {
        type: "string",
        enum: FORMULARY_DRUG_IDS,
        maxLength: FORMULARY_DRUG_ID_MAX_LENGTH,
        description: "Formulary drug id, e.g. 'carprofen'",
      },
      species: { type: "string", enum: ["canine", "feline"] },
      weightKg: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: DOSING_WEIGHT_MAX_KG,
      },
      concentrationMgPerMl: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["drugId", "species", "weightKg"],
  },
  zod: z.object({
    drugId: formularyDrugIdInput,
    species: z.enum(["canine", "feline"]),
    weightKg: z.number().finite().positive().max(DOSING_WEIGHT_MAX_KG),
    concentrationMgPerMl: z.number().finite().positive().optional(),
  }),
  readOnly: true,
  async execute(args) {
    const input = this.zod.parse(args) as {
      drugId: string;
      species: "canine" | "feline";
      weightKg: number;
      concentrationMgPerMl?: number;
    };
    // calculateDose throws on bad input; the runner catches and returns the message.
    return calculateDose(input);
  },
};

const listTreatmentPlans: AgentTool = {
  name: "list_treatment_plans",
  description:
    "List a patient's treatment plans with their items and a progress summary.",
  inputSchema: {
    type: "object",
    properties: { patientId: { type: "string", description: "Patient UUID" } },
    required: ["patientId"],
  },
  zod: z.object({ patientId: z.string().uuid() }),
  readOnly: true,
  async execute(args, ctx) {
    const { patientId } = this.zod.parse(args) as { patientId: string };
    const plans = await ctx.db
      .select()
      .from(treatmentPlans)
      .where(
        and(
          eq(treatmentPlans.patientId, patientId),
          eq(treatmentPlans.practiceId, ctx.practiceId),
          isNull(treatmentPlans.deletedAt)
        )
      )
      .orderBy(desc(treatmentPlans.createdAt));
    if (plans.length === 0) return [];

    const items = await ctx.db
      .select()
      .from(treatmentPlanItems)
      .where(
        and(
          inArray(treatmentPlanItems.planId, plans.map((p) => p.id)),
          isNull(treatmentPlanItems.deletedAt)
        )
      )
      .orderBy(asc(treatmentPlanItems.sortOrder));

    return plans.map((plan) => {
      const planItems = items.filter((i) => i.planId === plan.id);
      return {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        items: planItems.map((i) => ({ description: i.description, status: i.status })),
        progress: summarizePlanProgress(
          planItems.map((i) => ({ status: i.status as PlanItemStatus }))
        ),
      };
    });
  },
};

const recordVitalSigns: AgentTool = {
  name: "record_vital_signs",
  description:
    "Record a vital-signs entry for a patient. All measurements are optional; provide what was taken.",
  inputSchema: {
    type: "object",
    properties: {
      patientId: { type: "string", description: "Patient UUID" },
      temperatureC: { type: "number", description: "Celsius, one decimal place max" },
      heartRateBpm: { type: "number" },
      respiratoryRateBpm: { type: "number" },
      weightKg: { type: "number", description: "Kilograms, three decimal places max" },
      bodyConditionScore: { type: "number", description: "1-9" },
      painScore: { type: "number", description: "0-10" },
      capillaryRefillSec: { type: "number", description: "Seconds, one decimal place max" },
      notes: { type: "string" },
    },
    required: ["patientId"],
  },
  zod: z.object({
    patientId: z.string().uuid(),
    temperatureC: vitalTemperatureInput.optional(),
    heartRateBpm: z.number().int().min(0).max(400).optional(),
    respiratoryRateBpm: z.number().int().min(0).max(300).optional(),
    weightKg: vitalWeightInput.optional(),
    bodyConditionScore: z.number().int().min(1).max(9).optional(),
    painScore: z.number().int().min(0).max(10).optional(),
    capillaryRefillSec: vitalCapillaryRefillInput.optional(),
    notes: agentOptionalNotesInput,
  }),
  readOnly: false,
  requiredApiScopes: ["records:write"],
  async execute(args, ctx) {
    const input = this.zod.parse(args) as {
      patientId: string;
      temperatureC?: number;
      heartRateBpm?: number;
      respiratoryRateBpm?: number;
      weightKg?: number;
      bodyConditionScore?: number;
      painScore?: number;
      capillaryRefillSec?: number;
      notes?: string;
    };
    if (!(await activePatient(ctx, input.patientId))) {
      return { error: "Patient not found" };
    }

    const [row] = await ctx.db
      .insert(vitalSigns)
      .values({
        practiceId: ctx.practiceId,
        patientId: input.patientId,
        // The agent is not a user row; leave recordedBy null.
        recordedBy: null,
        temperatureC: input.temperatureC?.toString(),
        heartRateBpm: input.heartRateBpm,
        respiratoryRateBpm: input.respiratoryRateBpm,
        weightKg: input.weightKg?.toString(),
        bodyConditionScore: input.bodyConditionScore,
        painScore: input.painScore,
        capillaryRefillSec: input.capillaryRefillSec?.toString(),
        notes: input.notes ?? null,
      })
      .returning({ id: vitalSigns.id, recordedAt: vitalSigns.recordedAt });
    return { id: row!.id, recordedAt: row!.recordedAt };
  },
};

const findOpenSlotsTool: AgentTool = {
  name: "find_open_slots",
  description:
    "Find open appointment times on a date (optionally for a specific doctor or room). Use before book_appointment to pick a free time.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD" },
      durationMinutes: { type: "number" },
      doctorId: { type: "string" },
      roomId: { type: "string" },
      locationId: { type: "string" },
    },
    required: ["date"],
  },
  zod: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    durationMinutes: z.number().int().min(10).max(240).optional(),
    doctorId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
  }),
  readOnly: true,
  async execute(args, ctx) {
    const input = this.zod.parse(args) as {
      date: string;
      durationMinutes?: number;
      doctorId?: string;
      roomId?: string;
      locationId?: string;
    };
    const resources = await validateScheduleResources(ctx, input);
    if (!resources.ok) return { error: resources.error };
    const location = await resolveAppointmentLocation(ctx.db, {
      practiceId: ctx.practiceId,
      locationId: input.locationId,
      doctorId: input.doctorId,
      roomId: input.roomId,
    });
    if (!location.ok) return { error: location.message };

    const timezone = await practiceTimeZone(ctx);
    const dayStart = dateInputTimeUtcInstant(
      input.date,
      { hour: 8 },
      timezone
    );
    const dayEnd = dateInputTimeUtcInstant(
      input.date,
      { hour: 18 },
      timezone
    );

    const rows = await ctx.db
      .select({
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        doctorId: appointments.doctorId,
        roomId: appointments.roomId,
        locationId: appointments.locationId,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          isNull(appointments.deletedAt),
          not(inArray(appointments.status, ["cancelled", "no_show"])),
          lt(appointments.startTime, dayEnd),
          gt(appointments.endTime, dayStart)
        )
      );

    const busy = rows.filter((r) => {
      if (input.doctorId && r.doctorId === input.doctorId) return true;
      if (input.roomId && r.roomId === input.roomId) return true;
      return (
        !input.doctorId && !input.roomId && r.locationId === location.locationId
      );
    });

    return findOpenSlots({
      dayStart,
      dayEnd,
      slotMinutes: input.durationMinutes ?? 30,
      busy,
    }).map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  findClient,
  getPatientSummary,
  listLocations,
  listAppointments,
  findOpenSlotsTool,
  bookAppointment,
  listOverdueVaccinations,
  calculateDrugDose,
  listTreatmentPlans,
  recordVitalSigns,
];

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/** Tool definitions in Anthropic Messages API format. */
export function anthropicToolDefs() {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
