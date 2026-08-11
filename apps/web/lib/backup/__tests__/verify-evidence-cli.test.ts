import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PRACTICE_EXPORT_SECTIONS } from "../export";

const script = resolve("scripts/verify-backup-evidence.mjs");
const tempDirectories: string[] = [];
const practiceId = "11111111-1111-4111-8111-111111111111";
const backupDate = "2026-08-10";
const exportedAt = "2026-08-10T09:30:00.000Z";

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function evidenceFixture(
  options: {
    omitVersion?: boolean;
    providerNullVersion?: boolean;
    formatVersion?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "openvpm-backup-evidence-"));
  tempDirectories.push(directory);
  const objectPath = join(directory, "backup.json");
  const catalogPath = join(directory, "catalog.json");
  const sections = Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [section, []]),
  ) as Record<string, unknown[]>;
  sections.clients = [{ id: "client-1" }, { id: "client-2" }];
  sections.patients = [
    { id: "patient-1" },
    { id: "patient-2" },
    { id: "patient-3" },
  ];
  const counts = Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [
      section,
      sections[section]!.length,
    ]),
  );
  const formatVersion = options.formatVersion ?? 6;
  const objectBody = Buffer.from(
    JSON.stringify({
      formatVersion,
      practiceId,
      exportedAt,
      counts,
      ...sections,
    }),
  );
  const checksumSha256 = sha256(objectBody);
  const objectKey =
    `database-backups/v2/${practiceId}/${backupDate}/` +
    `${checksumSha256}.json`;
  const catalogBody = Buffer.from(
    JSON.stringify({
      catalogFormatVersion: 2,
      practiceId,
      backupDate,
      exportedAt,
      objectKey,
      checksumSha256,
      fileSizeBytes: objectBody.byteLength,
      exportFormatVersion: formatVersion,
      counts,
      contentType: "application/json",
      objectEtag: '"replica-etag"',
      objectVersionId: options.omitVersion
        ? null
        : options.providerNullVersion
          ? "null"
          : "replica-version-17",
    }),
  );
  const catalogKey =
    `database-backup-catalog/v2/${practiceId}/${backupDate}/` +
    `${sha256(catalogBody)}.json`;
  writeFileSync(objectPath, objectBody);
  writeFileSync(catalogPath, catalogBody);
  return { catalogKey, catalogPath, objectPath };
}

function run(fixture: ReturnType<typeof evidenceFixture>) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--catalog",
      fixture.catalogPath,
      "--catalog-key",
      fixture.catalogKey,
      "--object",
      fixture.objectPath,
      "--expected-practice",
      practiceId,
      "--expected-date",
      backupDate,
    ],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("backup recovery evidence CLI", () => {
  it("verifies checksum-addressed catalog and exact-version recovery evidence without restoring", () => {
    const result = run(evidenceFixture());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "artifact_integrity_verified",
      verificationScope: "artifact_integrity_and_canonical_counts",
      applicationRestoreValidationPerformed: false,
      restorePerformed: false,
      practiceId,
      backupDate,
      objectVersionId: "replica-version-17",
      fileSizeBytes: expect.any(Number),
      counts: { clients: 2, patients: 3 },
    });
  });

  it("rejects the provider-null sentinel as exact-version evidence", () => {
    const result = run(evidenceFixture({ providerNullVersion: true }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "objectVersionId must identify a versioned object",
    );
  });

  it("rejects artifacts outside the one canonical supported export format", () => {
    const result = run(evidenceFixture({ formatVersion: 5 }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exportFormatVersion must be 6");
  });

  it("checks catalog counts against the actual canonical section arrays", () => {
    const fixture = evidenceFixture();
    const backup = JSON.parse(
      readFileSync(fixture.objectPath, "utf8"),
    ) as Record<string, unknown>;
    backup.clients = [];
    const objectBody = Buffer.from(JSON.stringify(backup));
    writeFileSync(fixture.objectPath, objectBody);
    const objectChecksum = sha256(objectBody);
    const catalog = JSON.parse(
      readFileSync(fixture.catalogPath, "utf8"),
    ) as Record<string, unknown>;
    catalog.checksumSha256 = objectChecksum;
    catalog.fileSizeBytes = objectBody.byteLength;
    catalog.objectKey =
      `database-backups/v2/${practiceId}/${backupDate}/` +
      `${objectChecksum}.json`;
    const catalogBody = Buffer.from(JSON.stringify(catalog));
    writeFileSync(fixture.catalogPath, catalogBody);
    fixture.catalogKey =
      `database-backup-catalog/v2/${practiceId}/${backupDate}/` +
      `${sha256(catalogBody)}.json`;

    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "backup object count for clients does not match its actual rows",
    );
  });

  it("rejects a catalog that cannot identify an exact provider version", () => {
    const result = run(evidenceFixture({ omitVersion: true }));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "objectVersionId must be a non-empty string",
    );
  });

  it("rejects object bytes that no longer match the immutable catalog", () => {
    const fixture = evidenceFixture();
    writeFileSync(fixture.objectPath, '{"tampered":true}');

    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/byte length|checksum/);
  });
});
