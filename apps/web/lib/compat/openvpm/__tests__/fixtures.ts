import type { clients, patients, appointments, soapNotes } from "@openpims/db";

type ClientRow = typeof clients.$inferSelect;
type PatientRow = typeof patients.$inferSelect;
type AppointmentRow = typeof appointments.$inferSelect;
type SoapNoteRow = typeof soapNotes.$inferSelect;

export const CREATED = new Date("2026-01-02T03:04:05.000Z");
export const UPDATED = new Date("2026-02-03T04:05:06.000Z");

export function clientRow(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    practiceId: "99999999-9999-9999-9999-999999999999",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "555-0100",
    address: "1 Main St",
    city: "Tampa",
    state: "FL",
    zip: "33601",
    emergencyContact: "John Doe",
    emergencyPhone: "555-0101",
    preferredContactMethod: "email",
    notes: "VIP",
    accessToken: null,
    ...overrides,
  } as ClientRow;
}

export function patientRow(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    practiceId: "99999999-9999-9999-9999-999999999999",
    clientId: "11111111-1111-1111-1111-111111111111",
    name: "Rex",
    species: "canine",
    breed: "Labrador",
    sex: "male_neutered",
    dob: "2020-05-15",
    color: "black",
    microchipNumber: "985112345678900",
    photoUrl: null,
    status: "active",
    ...overrides,
  } as PatientRow;
}

export function appointmentRow(
  overrides: Partial<AppointmentRow> = {}
): AppointmentRow {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    practiceId: "99999999-9999-9999-9999-999999999999",
    startTime: new Date("2026-03-01T09:00:00.000Z"),
    endTime: new Date("2026-03-01T09:30:00.000Z"),
    typeId: null,
    patientId: "22222222-2222-2222-2222-222222222222",
    clientId: "11111111-1111-1111-1111-111111111111",
    doctorId: null,
    roomId: null,
    locationId: null,
    status: "scheduled",
    notes: null,
    recurringSeriesId: null,
    ...overrides,
  } as AppointmentRow;
}

export function soapNoteRow(overrides: Partial<SoapNoteRow> = {}): SoapNoteRow {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    practiceId: "99999999-9999-9999-9999-999999999999",
    patientId: "22222222-2222-2222-2222-222222222222",
    appointmentId: "33333333-3333-3333-3333-333333333333",
    authorId: "55555555-5555-5555-5555-555555555555",
    subjective: "Owner reports mild coughing.",
    objective: "BAR, eupneic in room.",
    assessment: "Mild tracheobronchitis.",
    plan: "Rest and monitor appetite.",
    ...overrides,
  } as SoapNoteRow;
}
