import type { clients, patients, appointments, soapNotes } from "@openpims/db";
import type {
  ApiClient,
  ApiPatient,
  ApiAppointment,
  ApiSoapNote,
  AppointmentCreate,
} from "./schema";

type ClientRow = typeof clients.$inferSelect;
type PatientRow = typeof patients.$inferSelect;
type AppointmentRow = typeof appointments.$inferSelect;
type SoapNoteRow = typeof soapNotes.$inferSelect;

/**
 * Pure translation between internal Drizzle rows and the public v1 API shapes.
 * No I/O, no db — trivially unit-testable. This is the only place that knows
 * about the enum/field crosswalk between internal and external vocabularies.
 */

// --- Enum crosswalks ---------------------------------------------------------

const SPECIES_TO_API: Record<PatientRow["species"], ApiPatient["species"]> = {
  canine: "dog",
  feline: "cat",
  avian: "bird",
  rabbit: "rabbit",
  reptile: "reptile",
  equine: "horse",
  bovine: "other",
  ovine: "other",
  caprine: "other",
  porcine: "other",
  poultry: "bird",
  camelid: "other",
  other: "other",
};

/** Internal sex enum collapses sex + neuter status; the API splits them. */
function sexToApi(sex: PatientRow["sex"]): {
  sex: ApiPatient["sex"];
  neutered: boolean | null;
} {
  switch (sex) {
    case "male":
      return { sex: "male", neutered: false };
    case "female":
      return { sex: "female", neutered: false };
    case "male_neutered":
      return { sex: "male", neutered: true };
    case "female_spayed":
      return { sex: "female", neutered: true };
    default:
      return { sex: "unknown", neutered: null };
  }
}

function iso(d: Date): string {
  return d.toISOString();
}

// --- Outbound (internal row -> API shape) ------------------------------------

export function toApiClient(row: ClientRow): ApiClient {
  return {
    id: row.id,
    first_name: row.firstName,
    last_name: row.lastName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    preferred_contact_method: row.preferredContactMethod,
    notes: row.notes,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function toApiPatient(row: PatientRow): ApiPatient {
  const { sex, neutered } = sexToApi(row.sex);
  return {
    id: row.id,
    client_id: row.clientId,
    name: row.name,
    species: SPECIES_TO_API[row.species],
    breed: row.breed,
    sex,
    neutered,
    // `dob` is a Postgres `date` column — Drizzle returns it as a "YYYY-MM-DD" string.
    date_of_birth: row.dob,
    color: row.color,
    microchip_number: row.microchipNumber,
    status: row.status,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function toApiAppointment(row: AppointmentRow): ApiAppointment {
  return {
    id: row.id,
    start_time: iso(row.startTime),
    end_time: iso(row.endTime),
    status: row.status,
    client_id: row.clientId,
    patient_id: row.patientId,
    doctor_id: row.doctorId,
    type_id: row.typeId,
    room_id: row.roomId,
    location_id: row.locationId,
    notes: row.notes,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function toApiSoapNote(row: SoapNoteRow, source: string): ApiSoapNote {
  return {
    id: row.id,
    patient_id: row.patientId,
    appointment_id: row.appointmentId,
    author_id: row.authorId,
    subjective: row.subjective,
    objective: row.objective,
    assessment: row.assessment,
    plan: row.plan,
    source,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

// --- Inbound (API body -> internal insert) -----------------------------------

/**
 * Translate a validated create-appointment body into internal insert values.
 * `practiceId` is added by the handler from the authenticated key, never the body.
 */
export function fromApiAppointmentCreate(
  body: AppointmentCreate,
): Omit<typeof appointments.$inferInsert, "practiceId"> {
  return {
    startTime: new Date(body.start_time),
    endTime: new Date(body.end_time),
    clientId: body.client_id ?? null,
    patientId: body.patient_id ?? null,
    doctorId: body.doctor_id ?? null,
    typeId: body.type_id ?? null,
    roomId: body.room_id ?? null,
    locationId: body.location_id ?? null,
    notes: body.notes ?? null,
  };
}
