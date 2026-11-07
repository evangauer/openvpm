import { describe, expect, it } from "vitest";
import { APPOINTMENT_NOTES_MAX_LENGTH } from "@/lib/scheduling/appointment-policy";
import {
  filterPrevisitIntakeByFieldKeys,
  preflightOnlineBookingAppointmentNote,
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

describe("preflightOnlineBookingAppointmentNote", () => {
  it("preserves the existing note when no intake was provided", () => {
    expect(
      preflightOnlineBookingAppointmentNote({ reason: " New calf checkup " }),
    ).toEqual({ ok: true, note: "[Online request] New calf checkup" });
  });

  it("retains every accepted field and puts service address before history", () => {
    const result = preflightOnlineBookingAppointmentNote({
      reason: "Not eating",
      intake: {
        serviceAddress: "North pasture\n10 Farm Road",
        symptoms: "Low energy and coughing",
        concernOnset: "Yesterday",
        currentMedications: "None",
        allergies: "Penicillin reaction",
        medicalHistory: "Prior pneumonia",
        diet: "Pasture and hay",
        handlingNotes: "Call before entering the gate",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { note } = result;
    expect(note).toContain(
      "Service/farm address (owner-reported): North pasture 10 Farm Road",
    );
    for (const expected of [
      "Current signs: Low energy and coughing",
      "Started or changed: Yesterday",
      "Current medications/supplements: None",
      "Reported allergies/reactions: Penicillin reaction",
      "Relevant history: Prior pneumonia",
      "Diet: Pasture and hay",
      "Handling/access notes: Call before entering the gate",
    ]) {
      expect(note).toContain(expected);
    }
    expect(note.indexOf("Service/farm address")).toBeLessThan(
      note.indexOf("Client-reported pre-visit history"),
    );
  });

  it("accepts an exact-boundary handoff without truncation", () => {
    const reason = "r".repeat(1000);
    const serviceAddress = "a".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH);
    let boundary: { ok: true; note: string; symptomLength: number } | undefined;

    for (
      let symptomLength = 1;
      symptomLength <= PREVISIT_INTAKE_FIELD_MAX_LENGTH;
      symptomLength += 1
    ) {
      const result = preflightOnlineBookingAppointmentNote({
        reason,
        intake: {
          serviceAddress,
          symptoms: "s".repeat(symptomLength),
        },
      });
      if (result.ok && result.note.length === APPOINTMENT_NOTES_MAX_LENGTH) {
        boundary = { ...result, symptomLength };
        break;
      }
    }

    expect(boundary).toBeDefined();
    expect(boundary?.note).toContain(reason);
    expect(boundary?.note).toContain(serviceAddress);
    expect(boundary?.note).toContain(
      `Current signs: ${"s".repeat(boundary?.symptomLength ?? 0)}`,
    );
    expect(boundary?.note).not.toContain("…");

    const firstRejected = preflightOnlineBookingAppointmentNote({
      reason,
      intake: {
        serviceAddress,
        symptoms: "s".repeat((boundary?.symptomLength ?? 0) + 1),
      },
    });
    expect(firstRejected.ok).toBe(false);
    if (firstRejected.ok) {
      throw new Error("Expected first over-boundary character to be rejected");
    }
    expect(firstRejected.overBy).toBe(1);
    expect(firstRejected.maxLength).toBe(APPOINTMENT_NOTES_MAX_LENGTH);
  });

  it("rejects a large aggregate overflow with an actionable error", () => {
    const result = preflightOnlineBookingAppointmentNote({
      reason: "r".repeat(1000),
      intake: {
        serviceAddress: "a".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH),
        symptoms: "s".repeat(PREVISIT_INTAKE_FIELD_MAX_LENGTH),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected aggregate preflight rejection");
    expect(result.overBy).toBeGreaterThan(0);
    expect(result.maxLength).toBe(APPOINTMENT_NOTES_MAX_LENGTH);
    expect(result.message).toContain("Visit details are too long to send");
    expect(result.message).toContain(`at least ${result.overBy}`);
  });
});
