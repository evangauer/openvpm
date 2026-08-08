export const WEBHOOK_EVENT_DEFINITIONS = [
  {
    event: "appointment.created",
    description: "New appointment created",
  },
  {
    event: "appointment.checked_in",
    description: "Appointment checked in",
  },
  {
    event: "appointment.rescheduled",
    description: "Appointment rescheduled",
  },
  {
    event: "appointment.cancelled",
    description: "Appointment cancelled",
  },
  {
    event: "client.created",
    description: "New client record created",
  },
  {
    event: "patient.created",
    description: "New patient record created",
  },
  {
    event: "soap_note.created",
    description: "SOAP note created",
  },
  {
    event: "vaccination.recorded",
    description: "Vaccination recorded",
  },
  {
    event: "problem.created",
    description: "Problem list item created",
  },
  {
    event: "prescription.created",
    description: "Prescription created",
  },
  {
    event: "prescription.refill_dispensed",
    description: "Prescription refill dispensed",
  },
  {
    event: "prescription.refill_authorized",
    description: "External prescription refill authorized",
  },
  {
    event: "prescription.completed",
    description: "Prescription completed",
  },
  {
    event: "prescription.cancelled",
    description: "Prescription cancelled",
  },
  {
    event: "prescription.expired",
    description: "Prescription expired",
  },
  {
    event: "lab_result.created",
    description: "Lab result created",
  },
  {
    event: "procedure.created",
    description: "Procedure created",
  },
  {
    event: "invoice.paid",
    description: "Invoice marked paid",
  },
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENT_DEFINITIONS)[number]["event"];

export const WEBHOOK_EVENTS = WEBHOOK_EVENT_DEFINITIONS.map(
  (definition) => definition.event
) as [WebhookEvent, ...WebhookEvent[]];
