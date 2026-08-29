import { createHash } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const LEGACY_FILE_RECOVERY_CONFIRMATION = "RESTORE-LEGACY-FILE";

export type LegacyFileRecoveryArgs = {
  command: "audit" | "restore";
  fileId: string;
  execute: boolean;
  confirmation?: string;
};

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseLegacyFileRecoveryArgs(
  args: string[],
): LegacyFileRecoveryArgs {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const command = normalizedArgs[0];
  if (command !== "audit" && command !== "restore") {
    throw new Error("First argument must be audit or restore.");
  }

  const fileId = flagValue(normalizedArgs, "file-id")?.trim() ?? "";
  if (!UUID_PATTERN.test(fileId)) {
    throw new Error("--file-id must be a UUID.");
  }

  const execute = normalizedArgs.includes("--execute");
  const confirmation = flagValue(normalizedArgs, "confirmation")?.trim();
  if (command === "audit" && execute) {
    throw new Error("audit is always read-only and does not accept --execute.");
  }
  if (command === "restore" && execute) {
    const expected = `${LEGACY_FILE_RECOVERY_CONFIRMATION}:${fileId}`;
    if (confirmation !== expected) {
      throw new Error(`--confirmation must exactly equal ${expected}.`);
    }
  }

  return { command, fileId, execute, confirmation };
}

export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function inspectLegacyFileBytes(input: {
  body: Uint8Array;
  expectedFileSizeBytes: number | null;
  expectedChecksumSha256: string | null;
}): {
  checksumSha256: string;
  fileSizeBytes: number;
  sizeMatches: boolean;
  checksumMatches: boolean;
} {
  const fileSizeBytes = input.body.byteLength;
  const checksumSha256 = sha256Hex(input.body);
  return {
    checksumSha256,
    fileSizeBytes,
    sizeMatches:
      input.expectedFileSizeBytes === null ||
      input.expectedFileSizeBytes === fileSizeBytes,
    checksumMatches:
      input.expectedChecksumSha256 === null ||
      input.expectedChecksumSha256 === checksumSha256,
  };
}

export function bytesMatch(
  body: Uint8Array,
  checksumSha256: string,
  fileSizeBytes: number,
): boolean {
  return (
    body.byteLength === fileSizeBytes && sha256Hex(body) === checksumSha256
  );
}
