import { and, eq, isNull } from "drizzle-orm";
import { files, labReportReceipts } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  ManagedUploadConflictError,
  type ManagedUploadReservation,
} from "./managed-file-upload";

export function labReportIntakeEnabled() {
  return process.env.NEXT_PUBLIC_LAB_REPORT_INTAKE_ENABLED === "true";
}

/** Called in the upload's recovery-lease transaction, after byte verification.
 * The digest uniqueness constraint makes simultaneous identical uploads converge. */
export async function receiveLabReport(
  tx: Database,
  reservation: ManagedUploadReservation,
  supersedesId: string | null,
) {
  const [verified] = await tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.category, "lab-results"),
        eq(files.storageStatus, "available"),
        eq(files.checksumSha256, reservation.checksumSha256),
        isNull(files.deletedAt),
      ),
    );
  if (!verified) throw new Error("Lab report file is not verified");
  if (supersedesId) {
    const [previous] = await tx
      .select({
        id: labReportReceipts.id,
        checksum: labReportReceipts.checksumSha256,
      })
      .from(labReportReceipts)
      .where(
        and(
          eq(labReportReceipts.id, supersedesId),
          eq(labReportReceipts.practiceId, reservation.practiceId),
        ),
      );
    if (!previous)
      throw new ManagedUploadConflictError(
        "The previous report is unavailable. Refresh and try again.",
      );
    if (previous.checksum === reservation.checksumSha256)
      throw new ManagedUploadConflictError(
        "This is the same file as the previous report. Choose the revised PDF.",
      );
  }
  const [receipt] = await tx
    .insert(labReportReceipts)
    .values({
      practiceId: reservation.practiceId,
      fileId: reservation.id,
      checksumSha256: reservation.checksumSha256,
      receivedBy: reservation.uploadedBy,
      supersedesId,
    })
    .onConflictDoNothing()
    .returning({ id: labReportReceipts.id });
  if (receipt) return { reportId: receipt.id, duplicate: false };
  const [existing] = await tx
    .select()
    .from(labReportReceipts)
    .where(
      and(
        eq(labReportReceipts.practiceId, reservation.practiceId),
        eq(labReportReceipts.checksumSha256, reservation.checksumSha256),
      ),
    );
  if (!existing || existing.supersedesId !== supersedesId) {
    throw new ManagedUploadConflictError(
      "This PDF has already been imported with a different revision link. Open the existing report.",
    );
  }
  return { reportId: existing.id, duplicate: true };
}
