import {
  sendSms,
  type SmsDispatchResult,
} from "@/lib/sms-dispatch";

export {
  prepareCampaignSmsBody,
  reconcileSmsSendAttempt,
  resendSmsAttempt,
  sendSms,
  SMS_COMPLIANCE_FOOTER,
  SMS_MAX_BODY_LENGTH,
} from "@/lib/sms-dispatch";
export type {
  SmsDispatchOutcome,
  SmsDispatchResult,
  SmsSendOptions,
} from "@/lib/sms-dispatch";

// ---------------------------------------------------------------------------
// Core send function
//
// Transport is provider-agnostic (lib/messaging): explicit locations bind the
// persisted provider and sender from one active location_messaging row. Calls
// without a location retain the env-selected provider/sender fallback for dev.
// This module keeps the hosted entitlement gate and usage metering.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Appointment reminder SMS
// ---------------------------------------------------------------------------

export async function sendAppointmentReminderSms(data: {
  to: string;
  patientName: string;
  appointmentDate: string;
  appointmentTime: string;
  practiceName: string;
  practicePhone?: string;
  practiceId: string;
  locationId?: string;
  clientId?: string;
  communicationId?: string;
  source?: string;
  sourceId?: string;
  idempotencyKey?: string;
}): Promise<SmsDispatchResult> {
  const phoneInfo = data.practicePhone
    ? `Call ${data.practicePhone} to reschedule.`
    : "Contact us to reschedule.";

  const body = `Reminder: ${data.patientName} has an appointment on ${data.appointmentDate} at ${data.appointmentTime}. ${phoneInfo}`;

  const result = await sendSms({
    to: data.to,
    body,
    practiceId: data.practiceId,
    locationId: data.locationId,
    clientId: data.clientId,
    communicationId: data.communicationId,
    source: data.source ?? "appointment_reminder",
    sourceId: data.sourceId,
    idempotencyKey: data.idempotencyKey,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Vaccination reminder SMS
// ---------------------------------------------------------------------------

export async function sendVaccinationReminderSms(data: {
  to: string;
  patientName: string;
  vaccineName: string;
  practiceName: string;
  practicePhone?: string;
  practiceId: string;
  locationId?: string;
  clientId?: string;
  communicationId?: string;
  sourceId?: string;
  idempotencyKey?: string;
}): Promise<SmsDispatchResult> {
  const phoneInfo = data.practicePhone
    ? `Call ${data.practicePhone} to schedule.`
    : "Contact us to schedule.";

  const body = `${data.patientName} is due for their ${data.vaccineName} vaccination. ${phoneInfo}`;

  const result = await sendSms({
    to: data.to,
    body,
    practiceId: data.practiceId,
    locationId: data.locationId,
    clientId: data.clientId,
    communicationId: data.communicationId,
    source: "vaccination_recall",
    sourceId: data.sourceId,
    idempotencyKey: data.idempotencyKey,
  });
  return result;
}
