import { describe, it, expect } from "vitest";
import type { patients } from "@openpims/db";
import {
  ApiClientSchema,
  ApiPatientSchema,
  ApiAppointmentSchema,
  ApiSoapNoteSchema,
  AppointmentCreateSchema,
  SoapNoteCreateSchema,
  APPOINTMENT_NOTES_MAX_LENGTH,
  TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE,
} from "../schema";
import {
  toApiClient,
  toApiPatient,
  toApiAppointment,
  toApiSoapNote,
} from "../mappers";
import { clientRow, patientRow, appointmentRow, soapNoteRow } from "./fixtures";

type PatientRow = typeof patients.$inferSelect;

/**
 * Contract guardrail: mapper output MUST satisfy the public schema. If an
 * internal change makes a mapper produce a shape the contract forbids, these
 * fail loudly before the change can break an integrator.
 */
describe("mapper output satisfies the public contract", () => {
  it("toApiClient -> ApiClientSchema", () => {
    expect(() => ApiClientSchema.parse(toApiClient(clientRow()))).not.toThrow();
  });

  it("toApiClient with nulls -> ApiClientSchema", () => {
    const row = clientRow({ email: null, phone: null, notes: null, preferredContactMethod: null });
    expect(() => ApiClientSchema.parse(toApiClient(row))).not.toThrow();
  });

  const speciesValues: PatientRow["species"][] = [
    "canine", "feline", "avian", "rabbit", "reptile", "equine", "other",
  ];
  it.each(speciesValues)("toApiPatient (%s) -> ApiPatientSchema", (species) => {
    expect(() => ApiPatientSchema.parse(toApiPatient(patientRow({ species })))).not.toThrow();
  });

  const sexValues: PatientRow["sex"][] = [
    "male", "female", "male_neutered", "female_spayed", null,
  ];
  it.each(sexValues.map((s) => [String(s), s] as const))(
    "toApiPatient (sex=%s) -> ApiPatientSchema",
    (_label, sex) => {
      expect(() => ApiPatientSchema.parse(toApiPatient(patientRow({ sex })))).not.toThrow();
    }
  );

  it("toApiAppointment -> ApiAppointmentSchema", () => {
    expect(() => ApiAppointmentSchema.parse(toApiAppointment(appointmentRow()))).not.toThrow();
  });

  it("toApiSoapNote -> ApiSoapNoteSchema", () => {
    expect(() =>
      ApiSoapNoteSchema.parse(toApiSoapNote(soapNoteRow(), "scribenote"))
    ).not.toThrow();
  });
});

describe("AppointmentCreateSchema validation", () => {
  it("accepts a valid body", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-03-01T09:00:00.000Z",
      end_time: "2026-03-01T09:30:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects end_time before start_time", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-03-01T10:00:00.000Z",
      end_time: "2026-03-01T09:30:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-ISO timestamps", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "March 1 2026",
      end_time: "2026-03-01T09:30:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects appointment timestamps without timezone offsets", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-03-01T09:00:00",
      end_time: "2026-03-01T09:30:00",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors).toMatchObject({
        start_time: [TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE],
        end_time: [TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE],
      });
    }
  });

  it("rejects impossible appointment calendar dates", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-02-31T09:00:00.000Z",
      end_time: "2026-02-31T09:30:00.000Z",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors).toMatchObject({
        start_time: [TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE],
        end_time: [TIMEZONE_QUALIFIED_TIMESTAMP_MESSAGE],
      });
    }
  });

  it("rejects a non-uuid client_id", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-03-01T09:00:00.000Z",
      end_time: "2026-03-01T09:30:00.000Z",
      client_id: "not-a-uuid",
    });
    expect(r.success).toBe(false);
  });

  it("rejects oversized notes", () => {
    const r = AppointmentCreateSchema.safeParse({
      start_time: "2026-03-01T09:00:00.000Z",
      end_time: "2026-03-01T09:30:00.000Z",
      notes: "x".repeat(APPOINTMENT_NOTES_MAX_LENGTH + 1),
    });
    expect(r.success).toBe(false);
  });
});

describe("SoapNoteCreateSchema validation", () => {
  it("accepts a valid AI scribe body", () => {
    const r = SoapNoteCreateSchema.safeParse({
      patient_id: "22222222-2222-2222-2222-222222222222",
      appointment_id: "33333333-3333-3333-3333-333333333333",
      subjective: "Eating well",
      source: "scribenote",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-uuid clinical references", () => {
    const r = SoapNoteCreateSchema.safeParse({
      patient_id: "not-a-uuid",
      author_id: "55555555-5555-5555-5555-555555555555",
      subjective: "Eating well",
      source: "scribenote",
    });
    expect(r.success).toBe(false);
  });

  it("rejects patient-only live SOAP notes without an appointment", () => {
    const r = SoapNoteCreateSchema.safeParse({
      patient_id: "22222222-2222-2222-2222-222222222222",
      subjective: "Eating well",
      source: "scribenote",
    });
    expect(r.success).toBe(false);
  });
});
