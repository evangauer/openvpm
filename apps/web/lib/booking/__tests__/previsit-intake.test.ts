import { describe, expect, it } from "vitest";
import { APPOINTMENT_NOTES_MAX_LENGTH } from "@/lib/scheduling/appointment-policy";
import {
  filterPrevisitIntakeByFieldKeys,
  formatOnlineBookingAppointmentNote,
  PREVISIT_INTAKE_FIELD_DEFINITIONS,
  PREVISIT_INTAKE_FIELD_MAX_LENGTH,
  previsitIntakeFieldKeyInput,
  previsitIntakeInput,
} from "../previsit-intake";

describe("PREVISIT_INTAKE_FIELD_DEFINITIONS", () => {
  it("puts service address first and exposes the eight fields in stable order", () => {
    expect(PREVISIT_INTAKE_FIELD_DEFINITIONS.map(({ key }) => key)).toEqual([
      "serviceAddress",
      "symptoms",
      "concernOnset",
      "currentMedications",
      "allergies",
      "medicalHistory",
      "diet",
      "handlingNotes",
    ]);
  });

  it("strictly validates configurable field keys", () => {
    expect(previsitIntakeFieldKeyInput.parse("serviceAddress")).toBe(
      "serviceAddress",
    );
    expect(
      previsitIntakeFieldKeyInput.safeParse("clinicianDiagnosis").success,
    ).toBe(false);
  });
});

describe("previsitIntakeInput", () => {
  it("normalizes optional owner-reported context", () => {
    expect(
      previsitIntakeInput.parse({
        serviceAddress: "  North pasture, 10 Farm Road  ",
        symptoms: "  Coughing  ",
        concernOnset: " ",
      }),
    ).toEqual({
      serviceAddress: "North pasture, 10 Farm Road",
      symptoms: "Coughing",
      concernOnset: undefined,
    });
  });

  it("rejects overlong and unexpected public input", () => {
    expect(
      previsitIntakeInput.safeParse({
        serviceAddress: "x".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      previsitIntakeInput.safeParse({ permanentClientAddress: "tampered" })
        .success,
    ).toBe(false);
  });
});

describe("filterPrevisitIntakeByFieldKeys", () => {
  it("drops disabled fields and emits values in catalog order", () => {
    const filtered = filterPrevisitIntakeByFieldKeys(
      previsitIntakeInput.parse({
        diet: "Hay",
        serviceAddress: "10 Farm Road",
        symptoms: "Coughing",
        handlingNotes: "Use the side gate",
      }),
      ["handlingNotes", "symptoms", "serviceAddress"],
    );

    expect(filtered).toEqual({
      serviceAddress: "10 Farm Road",
      symptoms: "Coughing",
      handlingNotes: "Use the side gate",
    });
    expect(Object.keys(filtered)).toEqual([
      "serviceAddress",
      "symptoms",
      "handlingNotes",
    ]);
  });

  it("returns no values when the page enables no optional fields", () => {
    expect(
      filterPrevisitIntakeByFieldKeys(
        previsitIntakeInput.parse({ serviceAddress: "Tampered submission" }),
        [],
      ),
    ).toEqual({});
  });
});

describe("formatOnlineBookingAppointmentNote", () => {
  it("preserves the existing note when no intake was provided", () => {
    expect(
      formatOnlineBookingAppointmentNote({ reason: " New calf checkup " }),
    ).toBe("[Online request] New calf checkup");
  });

  it("puts owner-reported service address before clinical history", () => {
    const note = formatOnlineBookingAppointmentNote({
      reason: "Not eating",
      intake: {
        serviceAddress: "North pasture\n10 Farm Road",
        symptoms: "Low energy and coughing",
        handlingNotes: "Call before entering the gate",
      },
    });

    expect(note).toContain(
      "Service/farm address (owner-reported): North pasture 10 Farm Road",
    );
    expect(note).toContain("Client-reported pre-visit history (unverified)");
    expect(note.indexOf("Service/farm address")).toBeLessThan(
      note.indexOf("Client-reported pre-visit history"),
    );
  });

  it("retains service address before truncating lower-priority history", () => {
    const note = formatOnlineBookingAppointmentNote({
      reason: "r".repeat(1000),
      intake: {
        serviceAddress: "North pasture, 10 Farm Road",
        symptoms: "s".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH),
        medicalHistory: "h".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH),
      },
    });

    expect(note).toHaveLength(APPOINTMENT_NOTES_MAX_LENGTH);
    expect(note).toContain(
      "Service/farm address (owner-reported): North pasture, 10 Farm Road",
    );
    expect(note.endsWith("…")).toBe(true);
  });
});
