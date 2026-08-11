#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  appointments,
  auditLog,
  clients,
  files,
  invoices,
  patients,
  practices,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  restorePracticeData,
  summarizePracticeExport,
  validatePracticeExportRestore,
} from "../lib/backup/export";
import { PRACTICE_BACKUP_JSON_MAX_BYTES } from "../lib/backup/policy";
import { withSystem } from "../lib/tenant-db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_FLAGS = [
  "verified-objects",
  "verified-user-access",
  "reconciled-messaging",
  "reconciled-payments",
  "reviewed-autonomous-jobs",
] as const;

type ParsedArgs = {
  command: "restore" | "release";
  practiceId: string;
  execute: boolean;
  confirmation?: string;
  backupPath?: string;
  practiceName?: string;
  timezone: string;
  releaseFlags: Record<(typeof RELEASE_FLAGS)[number], boolean>;
};

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseRecoveryArgs(args: string[]): ParsedArgs {
  const command = args[0];
  if (command !== "restore" && command !== "release") {
    throw new Error("First argument must be restore or release.");
  }
  const practiceId = flagValue(args, "practice-id")?.trim() ?? "";
  if (!UUID_PATTERN.test(practiceId)) {
    throw new Error("--practice-id must be a UUID.");
  }

  const parsed: ParsedArgs = {
    command,
    practiceId,
    execute: args.includes("--execute"),
    confirmation: flagValue(args, "confirmation"),
    backupPath: flagValue(args, "backup"),
    practiceName: flagValue(args, "practice-name")?.trim(),
    timezone: flagValue(args, "timezone")?.trim() || "America/New_York",
    releaseFlags: Object.fromEntries(
      RELEASE_FLAGS.map((flag) => [flag, args.includes(`--${flag}`)]),
    ) as ParsedArgs["releaseFlags"],
  };

  if (command === "restore" && (!parsed.backupPath || !parsed.practiceName)) {
    throw new Error("restore requires --backup and --practice-name.");
  }
  if (parsed.execute) {
    const expected = `${command.toUpperCase()}:${practiceId}`;
    if (parsed.confirmation !== expected) {
      throw new Error(`--confirmation must exactly equal ${expected}.`);
    }
  }
  if (
    command === "release" &&
    parsed.execute &&
    RELEASE_FLAGS.some((flag) => !parsed.releaseFlags[flag])
  ) {
    throw new Error(
      `release requires ${RELEASE_FLAGS.map((flag) => `--${flag}`).join(", ")}.`,
    );
  }
  return parsed;
}

function readBackup(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Backup path must be a regular file.");
  if (stat.size > PRACTICE_BACKUP_JSON_MAX_BYTES) {
    throw new Error("Backup exceeds the supported restore safety limit.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function ownerDatabase(): Promise<Database> {
  const ownerUrl = process.env.OWNER_RECOVERY_DATABASE_URL?.trim();
  if (!ownerUrl) {
    throw new Error(
      "OWNER_RECOVERY_DATABASE_URL is required for an executed owner recovery operation.",
    );
  }
  process.env.DATABASE_URL = ownerUrl;
  const { db } = await import("@openpims/db/client");
  return db;
}

async function assertFreshOrHeldShell(
  database: Database,
  input: Pick<ParsedArgs, "practiceId" | "practiceName" | "timezone">,
): Promise<"created" | "resumed"> {
  return withSystem(database, async (tx) => {
    const [existing] = await tx
      .select({
        id: practices.id,
        recoveryHold: practices.recoveryHold,
        deletedAt: practices.deletedAt,
      })
      .from(practices)
      .where(eq(practices.id, input.practiceId))
      .limit(1);

    if (existing && (existing.deletedAt || !existing.recoveryHold)) {
      throw new Error(
        "Target practice already exists outside protected recovery mode.",
      );
    }

    const coreRows = await Promise.all(
      [clients, patients, appointments, invoices].map((table) =>
        tx
          .select({ id: table.id })
          .from(table)
          .where(eq(table.practiceId, input.practiceId))
          .limit(1),
      ),
    );
    if (coreRows.some((rows) => rows.length > 0)) {
      throw new Error(
        "Recovery shell is not empty; owner review is required before retrying.",
      );
    }

    if (existing) return "resumed";

    const now = new Date();
    await tx.insert(practices).values({
      id: input.practiceId,
      name: input.practiceName!,
      timezone: input.timezone,
      settings: {},
      subscriptionTier: "free",
      billingStatus: "none",
      appointmentRemindersEnabled: false,
      calendarFeedToken: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      recoveryHold: true,
      recoveryHoldReason: "Owner disaster recovery pending reconciliation",
      recoveryHoldSetAt: now,
      recoveryHoldReleasedAt: null,
    });
    await tx.insert(auditLog).values({
      practiceId: input.practiceId,
      userId: null,
      action: "hold_set",
      entityType: "practice_recovery",
      entityId: input.practiceId,
      changes: { source: "owner_recovery_cli", state: "held" },
    });
    return "created";
  });
}

async function restore(database: Database, args: ParsedArgs, backup: unknown) {
  const shell = await assertFreshOrHeldShell(database, args);
  const result = await restorePracticeData(database, args.practiceId, backup);
  await withSystem(database, (tx) =>
    tx.insert(auditLog).values({
      practiceId: args.practiceId,
      userId: null,
      action: "restore_complete",
      entityType: "practice_recovery",
      entityId: args.practiceId,
      changes: {
        source: "owner_recovery_cli",
        state: "held",
        restoredRows: result.totalRows,
      },
    }),
  );
  return { shell, ...result };
}

async function release(database: Database, args: ParsedArgs) {
  return withSystem(database, async (tx) => {
    const [practice] = await tx
      .select({ recoveryHold: practices.recoveryHold })
      .from(practices)
      .where(
        and(eq(practices.id, args.practiceId), isNull(practices.deletedAt)),
      )
      .for("update")
      .limit(1);
    if (!practice?.recoveryHold) {
      throw new Error("Practice is missing or is not on recovery hold.");
    }

    const [unavailableFiles, activeUsers] = await Promise.all([
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(files)
        .where(
          and(
            eq(files.practiceId, args.practiceId),
            isNull(files.deletedAt),
            ne(files.storageStatus, "available"),
          ),
        ),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(eq(users.practiceId, args.practiceId), isNull(users.deletedAt)),
        ),
    ]);
    if ((unavailableFiles[0]?.count ?? 0) > 0) {
      throw new Error(
        "Recovery cannot be released while file manifests remain unavailable.",
      );
    }
    if ((activeUsers[0]?.count ?? 0) < 1) {
      throw new Error(
        "Recovery cannot be released until at least one user identity is restored.",
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(practices)
      .set({
        recoveryHold: false,
        recoveryHoldReleasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(practices.id, args.practiceId),
          eq(practices.recoveryHold, true),
          isNull(practices.deletedAt),
        ),
      )
      .returning({ id: practices.id });
    if (!updated) throw new Error("Recovery hold release lost its database lock.");

    await tx.insert(auditLog).values({
      practiceId: args.practiceId,
      userId: null,
      action: "hold_released",
      entityType: "practice_recovery",
      entityId: args.practiceId,
      changes: {
        source: "owner_recovery_cli",
        state: "released",
        checklist: RELEASE_FLAGS,
      },
    });
    return { releasedAt: now.toISOString() };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRecoveryArgs(argv);
  if (args.command === "restore") {
    const backup = readBackup(args.backupPath!);
    const summary = summarizePracticeExport(backup);
    const validation = validatePracticeExportRestore(backup);
    const backupPracticeId =
      backup && typeof backup === "object" && "practiceId" in backup
        ? (backup as { practiceId?: unknown }).practiceId
        : undefined;
    const backupFormatVersion =
      backup && typeof backup === "object" && "formatVersion" in backup
        ? (backup as { formatVersion?: unknown }).formatVersion
        : undefined;
    if (backupPracticeId !== args.practiceId) {
      throw new Error("Backup practiceId does not match --practice-id.");
    }
    if (!validation.valid || summary.missingSections.length > 0) {
      throw new Error("Backup failed the application restore contract.");
    }
    if (!args.execute) {
      console.log(
        JSON.stringify({
          status: "verified",
          dryRun: true,
          operation: "restore",
          practiceId: args.practiceId,
          formatVersion: backupFormatVersion,
          counts: summary.counts,
          recoveryHold: "will-remain-held",
        }),
      );
      return;
    }
    const database = await ownerDatabase();
    const result = await restore(database, args, backup);
    console.log(
      JSON.stringify({
        status: "restored",
        dryRun: false,
        practiceId: args.practiceId,
        shell: result.shell,
        restoredRows: result.totalRows,
        recoveryHold: "held",
      }),
    );
    return;
  }

  if (!args.execute) {
    console.log(
      JSON.stringify({
        status: "checklist-required",
        dryRun: true,
        operation: "release",
        practiceId: args.practiceId,
        requiredChecklist: RELEASE_FLAGS,
      }),
    );
    return;
  }
  const database = await ownerDatabase();
  const result = await release(database, args);
  console.log(
    JSON.stringify({
      status: "released",
      dryRun: false,
      practiceId: args.practiceId,
      releasedAt: result.releasedAt,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
