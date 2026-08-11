import { checksumSha256Hex } from "@/lib/file-replication";
import { normalizeS3VersionId } from "@/lib/s3";

export function databaseBackupReplicaKey(input: {
  practiceId: string;
  backupDate: string;
  checksumSha256: string;
}): string {
  return `database-backups/v2/${input.practiceId}/${input.backupDate}/${input.checksumSha256}.json`;
}

export function databaseBackupReplicaCatalog(input: {
  practiceId: string;
  backupDate: string;
  exportedAt: string;
  objectKey: string;
  checksumSha256: string;
  fileSizeBytes: number;
  exportFormatVersion: number;
  counts: Record<string, number>;
  objectEtag?: string;
  objectVersionId: string;
}): { key: string; body: Buffer; checksumSha256: string } {
  const objectVersionId = normalizeS3VersionId(input.objectVersionId);
  if (!objectVersionId) {
    throw new Error("Backup replica catalog requires an exact object version");
  }
  const body = Buffer.from(
    JSON.stringify({
      catalogFormatVersion: 2,
      practiceId: input.practiceId,
      backupDate: input.backupDate,
      exportedAt: input.exportedAt,
      objectKey: input.objectKey,
      checksumSha256: input.checksumSha256,
      fileSizeBytes: input.fileSizeBytes,
      exportFormatVersion: input.exportFormatVersion,
      counts: input.counts,
      contentType: "application/json",
      objectEtag: input.objectEtag ?? null,
      objectVersionId,
    }),
  );
  const checksumSha256 = checksumSha256Hex(body);

  return {
    key: `database-backup-catalog/v2/${input.practiceId}/${input.backupDate}/${checksumSha256}.json`,
    body,
    checksumSha256,
  };
}
