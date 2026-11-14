import { z } from "zod";

export function fieldVisitHref(patientId: string, appointmentId?: string) {
  const params = new URLSearchParams({ patientId });
  if (appointmentId) params.set("appointmentId", appointmentId);
  return `/offline/field.html#${params}`;
}

export function fieldPreparationTarget(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const patientId = params.get("patientId");
  const appointmentId = params.get("appointmentId");
  if (
    !z.string().uuid().safeParse(patientId).success ||
    (appointmentId !== null &&
      !z.string().uuid().safeParse(appointmentId).success)
  )
    return null;
  return { patientId: patientId!, ...(appointmentId ? { appointmentId } : {}) };
}
