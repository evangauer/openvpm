import { z } from "zod";
import { AI_SOURCE_MAX_LENGTH } from "@/lib/ai/soap";
import { SOAP_SECTION_MAX_LENGTH } from "@/lib/records/soap-content";

/**
 * The PUBLIC, frozen contract for the OpenVPM v1 REST API. These shapes are
 * owned by this file and are deliberately decoupled from the internal Drizzle
 * schema — internal columns may change without breaking integrators, as long as
 * the mappers (mappers.ts) keep producing these shapes.
 */

export const ApiSpeciesSchema = z.enum([
  "dog",
  "cat",
  "bird",
  "rabbit",
  "reptile",
  "horse",
  "other",
]);

export const ApiSexSchema = z.enum(["male", "female", "unknown"]);

export const APPOINTMENT_NOTES_MAX_LENGTH = 2000;
export const TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE =
  "must be a timezone-qualified ISO timestamp";

const ApiSoapSectionInputSchema = z
  .string()
  .trim()
  .max(
    SOAP_SECTION_MAX_LENGTH,
    `SOAP section must be at most ${SOAP_SECTION_MAX_LENGTH} characters.`
  )
  .optional();

export const ApiClientSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  preferred_contact_method: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ApiPatientSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  name: z.string(),
  species: ApiSpeciesSchema,
  breed: z.string().nullable(),
  sex: ApiSexSchema,
  neutered: z.boolean().nullable(),
  date_of_birth: z.string().nullable(),
  color: z.string().nullable(),
  microchip_number: z.string().nullable(),
  status: z.enum(["active", "inactive", "deceased"]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ApiAppointmentSchema = z.object({
  id: z.string().uuid(),
  start_time: z.string(),
  end_time: z.string(),
  status: z.enum([
    "scheduled",
    "confirmed",
    "checked_in",
    "in_exam",
    "checked_out",
    "no_show",
    "cancelled",
  ]),
  client_id: z.string().uuid().nullable(),
  patient_id: z.string().uuid().nullable(),
  doctor_id: z.string().uuid().nullable(),
  type_id: z.string().uuid().nullable(),
  room_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ApiSoapNoteSchema = z.object({
  id: z.string().uuid(),
  patient_id: z.string().uuid(),
  appointment_id: z.string().uuid().nullable(),
  author_id: z.string().uuid(),
  subjective: z.string().nullable(),
  objective: z.string().nullable(),
  assessment: z.string().nullable(),
  plan: z.string().nullable(),
  source: z.string().min(1).max(AI_SOURCE_MAX_LENGTH),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Inbound body for POST /api/v1/appointments. */
export const AppointmentCreateSchema = z
  .object({
    start_time: z
      .string()
      .datetime({ offset: true, message: TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE }),
    end_time: z
      .string()
      .datetime({ offset: true, message: TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE }),
    client_id: z.string().uuid().optional(),
    patient_id: z.string().uuid().optional(),
    doctor_id: z.string().uuid().optional(),
    type_id: z.string().uuid().optional(),
    room_id: z.string().uuid().optional(),
    notes: z.string().max(APPOINTMENT_NOTES_MAX_LENGTH).optional(),
  })
  .refine((b) => new Date(b.end_time) > new Date(b.start_time), {
    message: "end_time must be after start_time",
    path: ["end_time"],
  });

/** Inbound body for POST /api/v1/soap-notes. */
export const SoapNoteCreateSchema = z.object({
  patient_id: z.string().uuid(),
  appointment_id: z.string().uuid(),
  author_id: z.string().uuid().optional(),
  subjective: ApiSoapSectionInputSchema,
  objective: ApiSoapSectionInputSchema,
  assessment: ApiSoapSectionInputSchema,
  plan: ApiSoapSectionInputSchema,
  source: z.string().trim().min(1).max(AI_SOURCE_MAX_LENGTH),
});

export type ApiClient = z.infer<typeof ApiClientSchema>;
export type ApiPatient = z.infer<typeof ApiPatientSchema>;
export type ApiAppointment = z.infer<typeof ApiAppointmentSchema>;
export type ApiSoapNote = z.infer<typeof ApiSoapNoteSchema>;
export type AppointmentCreate = z.infer<typeof AppointmentCreateSchema>;
export type SoapNoteCreate = z.infer<typeof SoapNoteCreateSchema>;
