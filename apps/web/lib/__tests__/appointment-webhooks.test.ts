import { describe, expect, it } from "vitest";
import { appointmentCreatedWebhookPayload } from "../appointment-webhooks";

describe("appointment webhook payloads", () => {
  it("normalizes appointment.created payloads across booking sources", () => {
    const startTime = new Date("2026-07-01T15:00:00.000Z");
    const endTime = new Date("2026-07-01T15:30:00.000Z");

    expect(
      appointmentCreatedWebhookPayload(
        {
          id: "appointment-1",
          startTime,
          endTime,
          status: "scheduled",
          patientId: "patient-1",
          clientId: "client-1",
          doctorId: "doctor-1",
          typeId: "type-1",
          roomId: "room-1",
          locationId: "location-1",
        },
        "api"
      )
    ).toEqual({
      id: "appointment-1",
      startTime,
      endTime,
      status: "scheduled",
      patientId: "patient-1",
      clientId: "client-1",
      doctorId: "doctor-1",
      typeId: "type-1",
      roomId: "room-1",
      locationId: "location-1",
      source: "api",
    });
  });

  it("uses explicit nulls for optional appointment links", () => {
    const startTime = new Date("2026-07-01T15:00:00.000Z");
    const endTime = new Date("2026-07-01T15:30:00.000Z");

    expect(
      appointmentCreatedWebhookPayload(
        {
          id: "appointment-1",
          startTime,
          endTime,
        },
        "agent"
      )
    ).toMatchObject({
      status: null,
      patientId: null,
      clientId: null,
      doctorId: null,
      typeId: null,
      roomId: null,
      locationId: null,
      source: "agent",
    });
  });
});
