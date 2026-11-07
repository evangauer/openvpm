import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  files,
  labReportReceipts as receipts,
  labReportDecisions as decisions,
  patients,
  clients,
  users,
  practices,
} from "@openpims/db";
import { createRouter, protectedProcedure } from "../trpc";
import { labReportIntakeEnabled } from "@/lib/lab-report-intake";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";

const reportProcedure = protectedProcedure.use(async ({ ctx, next, type }) => {
  if (!labReportIntakeEnabled()) throw new TRPCError({ code: "NOT_FOUND" });
  const [actor] = await ctx.db
    .select({ role: users.role })
    .from(users)
    .innerJoin(
      practices,
      and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
    )
    .where(
      and(
        eq(users.id, ctx.user.id),
        eq(users.practiceId, ctx.practiceId),
        isNull(users.deletedAt),
      ),
    )
    .for("share", { of: users });
  if (
    !actor ||
    ![
      "admin",
      "veterinarian",
      "technician",
      ...(type === "query" ? ["viewer"] : []),
    ].includes(actor.role)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical report access is unavailable for this account.",
    });
  }
  if (
    type === "mutation" &&
    !(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: RECOVERY_HOLD_BLOCK_MESSAGE,
    });
  }
  return next({ ctx: { ...ctx, reportRole: actor.role } });
});

export const labReportsRouter = createRouter({
  list: reportProcedure
    .input(
      z.object({
        filter: z.enum(["unmatched", "unreviewed", "all"]).default("unmatched"),
        patientId: z.string().uuid().optional(),
        reportId: z.string().uuid().optional(),
        offset: z.number().int().min(0).max(100000).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const latest = ctx.db
        .selectDistinctOn([decisions.reportId])
        .from(decisions)
        .where(eq(decisions.practiceId, ctx.practiceId))
        .orderBy(decisions.reportId, desc(decisions.version))
        .as("latest_decision");
      const rows = await ctx.db
        .select({
          id: receipts.id,
          receivedAt: receipts.createdAt,
          supersedesId: receipts.supersedesId,
          fileName: files.fileName,
          fileUrl: files.fileUrl,
          storageStatus: files.storageStatus,
          state: latest.state,
          version: latest.version,
          patientId: latest.patientId,
          patientName: patients.name,
          clientId: patients.clientId,
          ownerFirstName: clients.firstName,
          ownerLastName: clients.lastName,
          revisionIds: sql<
            string[]
          >`array(select r.id::text from lab_report_receipts r where r.practice_id = ${ctx.practiceId} and r.supersedes_id = ${receipts.id} order by r.created_at, r.id)`,
        })
        .from(receipts)
        .innerJoin(
          files,
          and(
            eq(files.id, receipts.fileId),
            eq(files.practiceId, ctx.practiceId),
          ),
        )
        .leftJoin(latest, eq(latest.reportId, receipts.id))
        .leftJoin(
          patients,
          and(
            eq(patients.id, latest.patientId),
            eq(patients.practiceId, ctx.practiceId),
          ),
        )
        .leftJoin(
          clients,
          and(
            eq(clients.id, patients.clientId),
            eq(clients.practiceId, ctx.practiceId),
          ),
        )
        .where(
          and(
            eq(receipts.practiceId, ctx.practiceId),
            input.patientId ? eq(latest.patientId, input.patientId) : undefined,
            input.reportId ? eq(receipts.id, input.reportId) : undefined,
            input.filter === "unmatched"
              ? sql`coalesce(${latest.state}, 'unmatched') = 'unmatched'`
              : undefined,
            input.filter === "unreviewed"
              ? eq(latest.state, "matched")
              : undefined,
          ),
        )
        .orderBy(desc(receipts.createdAt), desc(receipts.id))
        .limit(26)
        .offset(input.offset);
      return {
        items: rows.slice(0, 25).map((row) => ({
          ...row,
          state: row.state ?? "unmatched",
          version: row.version ?? 0,
        })),
        hasMore: rows.length > 25,
      };
    }),
  history: reportProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: decisions.id,
          state: decisions.state,
          version: decisions.version,
          createdAt: decisions.createdAt,
          reason: decisions.reason,
          actorName: users.name,
          patientName: patients.name,
        })
        .from(decisions)
        .innerJoin(
          users,
          and(
            eq(users.id, decisions.actorId),
            eq(users.practiceId, ctx.practiceId),
          ),
        )
        .leftJoin(
          patients,
          and(
            eq(patients.id, decisions.patientId),
            eq(patients.practiceId, ctx.practiceId),
          ),
        )
        .where(
          and(
            eq(decisions.practiceId, ctx.practiceId),
            eq(decisions.reportId, input.id),
          ),
        )
        .orderBy(desc(decisions.version));
    }),
  decide: reportProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        expectedVersion: z.number().int().nonnegative(),
        state: z.enum(["matched", "reviewed", "unmatched", "dismissed"]),
        patientId: z.string().uuid().nullable(),
        reason: z.string().trim().max(500).default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Serialize every decision for a receipt. An exact retry returns its original
      // decision even if another user has subsequently advanced the report.
      await ctx.db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ctx.practiceId + ":lab-report:" + input.id}, 0))`,
      );
      const [report] = await ctx.db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.id, input.id),
            eq(receipts.practiceId, ctx.practiceId),
          ),
        );
      if (!report)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Report not found.",
        });
      const [retry] = await ctx.db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.practiceId, ctx.practiceId),
            eq(decisions.operationId, input.operationId),
          ),
        );
      if (retry) {
        if (
          retry.reportId !== input.id ||
          retry.actorId !== ctx.user.id ||
          retry.version !== input.expectedVersion + 1 ||
          retry.state !== input.state ||
          retry.patientId !== input.patientId ||
          (retry.reason ?? "") !== input.reason
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "This request was already used for another decision.",
          });
        return { id: retry.id };
      }
      const [latest] = await ctx.db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.reportId, report.id),
            eq(decisions.practiceId, ctx.practiceId),
          ),
        )
        .orderBy(desc(decisions.version))
        .limit(1);
      const state = latest?.state ?? "unmatched";
      if ((latest?.version ?? 0) !== input.expectedVersion)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This report changed in another session. Refresh before continuing.",
        });
      if (input.state === "reviewed") {
        if (!["admin", "veterinarian"].includes(ctx.reportRole))
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A veterinarian or administrator must review the report.",
          });
        if (state !== "matched" || input.patientId !== latest?.patientId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Match the report to a patient before reviewing it.",
          });
      } else if (input.state === "matched") {
        if (state !== "unmatched")
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Remove the existing match before choosing another patient.",
          });
      } else {
        if (
          input.patientId !== null ||
          !input.reason ||
          (input.state === "dismissed" && state !== "unmatched") ||
          (input.state === "unmatched" && state === "unmatched")
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Remove any match first and give a reason for this correction.",
          });
      }
      if (input.state === "matched" || input.state === "reviewed") {
        if (!input.patientId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a patient.",
          });
        const [patient] = await ctx.db
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.id, input.patientId),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .for("share");
        if (!patient)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Patient is unavailable.",
          });
        const [file] = await ctx.db
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.id, report.fileId),
              eq(files.practiceId, ctx.practiceId),
              eq(files.storageStatus, "available"),
              isNull(files.deletedAt),
            ),
          );
        if (!file)
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The original file is unavailable. Restore access before matching or reviewing it.",
          });
      }
      const [decision] = await ctx.db
        .insert(decisions)
        .values({
          practiceId: ctx.practiceId,
          reportId: report.id,
          actorId: ctx.user.id,
          version: input.expectedVersion + 1,
          operationId: input.operationId,
          state: input.state,
          patientId: input.patientId,
          reason: input.reason || null,
        })
        .returning({ id: decisions.id });
      return decision!;
    }),
});
