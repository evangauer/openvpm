import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  clientContacts,
  careReminders,
  clients,
  externalLabObservations,
  externalLabReports,
  externalPrescriptionFills,
  externalPrescriptions,
  files,
  historicalAppointments,
  historicalDocuments,
  legacyFinancialAllocations,
  legacyFinancialDocuments,
  legacyFinancialLineItems,
  legacyFinancialPayments,
  patients,
  practices,
  products,
  services,
} from "@openpims/db";
import { createRouter, protectedProcedure } from "../trpc";

const sectionInput = z.enum([
  "contacts",
  "appointments",
  "medications",
  "labs",
  "financial",
  "documents",
]);

const listInput = z.object({
  section: sectionInput,
  query: z.string().trim().max(100).default(""),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});

function fullName(firstName: unknown, lastName: unknown): string {
  return [firstName, lastName]
    .filter((part): part is string => typeof part === "string" && !!part)
    .join(" ");
}

function searchPattern(query: string): string {
  return `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export const migrationArchiveRouter = createRouter({
  reviewStatus: protectedProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ recoveryHold: practices.recoveryHold })
      .from(practices)
      .where(
        and(
          eq(practices.id, ctx.practiceId),
          isNull(practices.deletedAt),
        ),
      )
      .limit(1);

    if (!practice) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
    }
    return practice;
  }),

  summary: protectedProcedure.query(async ({ ctx }) => {
    const practiceId = ctx.practiceId;
    const [
      [clientCount],
      [patientCount],
      [reminderCount],
      [serviceCount],
      [productCount],
      [contacts],
      [appointments],
      [medications],
      [fills],
      [labs],
      [financial],
      [payments],
      [documents],
    ] = await Promise.all([
      ctx.db
        .select({ total: count() })
        .from(clients)
        .where(and(eq(clients.practiceId, practiceId), isNull(clients.deletedAt))),
      ctx.db
        .select({ total: count() })
        .from(patients)
        .where(and(eq(patients.practiceId, practiceId), isNull(patients.deletedAt))),
      ctx.db
        .select({ total: count() })
        .from(careReminders)
        .where(
          and(
            eq(careReminders.practiceId, practiceId),
            eq(careReminders.status, "open"),
            isNull(careReminders.deletedAt),
          ),
        ),
      ctx.db
        .select({ total: count() })
        .from(services)
        .where(and(eq(services.practiceId, practiceId), isNull(services.deletedAt))),
      ctx.db
        .select({ total: count() })
        .from(products)
        .where(and(eq(products.practiceId, practiceId), isNull(products.deletedAt))),
      ctx.db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${clientContacts.attributionStatus} = 'needs_review')::int`,
        })
        .from(clientContacts)
        .where(
          and(
            eq(clientContacts.practiceId, practiceId),
            isNull(clientContacts.deletedAt),
          ),
        ),
      ctx.db
        .select({ total: count() })
        .from(historicalAppointments)
        .where(
          and(
            eq(historicalAppointments.practiceId, practiceId),
            isNull(historicalAppointments.deletedAt),
          ),
        ),
      ctx.db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${externalPrescriptions.reviewStatus} = 'unreviewed')::int`,
        })
        .from(externalPrescriptions)
        .where(
          and(
            eq(externalPrescriptions.practiceId, practiceId),
            isNull(externalPrescriptions.deletedAt),
          ),
        ),
      ctx.db
        .select({ total: count() })
        .from(externalPrescriptionFills)
        .where(
          and(
            eq(externalPrescriptionFills.practiceId, practiceId),
            isNull(externalPrescriptionFills.deletedAt),
          ),
        ),
      ctx.db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${externalLabReports.attributionStatus} = 'needs_review' or ${externalLabReports.reviewStatus} = 'unreviewed')::int`,
        })
        .from(externalLabReports)
        .where(
          and(
            eq(externalLabReports.practiceId, practiceId),
            isNull(externalLabReports.deletedAt),
          ),
        ),
      ctx.db
        .select({
          total: count(),
          openBalance: sql<string>`coalesce(sum(${legacyFinancialDocuments.balance}), 0)::text`,
        })
        .from(legacyFinancialDocuments)
        .where(
          and(
            eq(legacyFinancialDocuments.practiceId, practiceId),
            isNull(legacyFinancialDocuments.deletedAt),
          ),
        ),
      ctx.db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${legacyFinancialPayments.attributionStatus} = 'needs_review')::int`,
        })
        .from(legacyFinancialPayments)
        .where(
          and(
            eq(legacyFinancialPayments.practiceId, practiceId),
            isNull(legacyFinancialPayments.deletedAt),
          ),
        ),
      ctx.db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${historicalDocuments.linkStatus} = 'needs_review')::int`,
        })
        .from(historicalDocuments)
        .where(
          and(
            eq(historicalDocuments.practiceId, practiceId),
            isNull(historicalDocuments.deletedAt),
          ),
        ),
    ]);

    return {
      practiceData: {
        clients: clientCount?.total ?? 0,
        patients: patientCount?.total ?? 0,
        openReminders: reminderCount?.total ?? 0,
        services: serviceCount?.total ?? 0,
        products: productCount?.total ?? 0,
      },
      contacts: contacts ?? { total: 0, needsReview: 0 },
      appointments: appointments ?? { total: 0 },
      medications: {
        ...(medications ?? { total: 0, needsReview: 0 }),
        fills: fills?.total ?? 0,
      },
      labs: labs ?? { total: 0, needsReview: 0 },
      financial: {
        ...(financial ?? { total: 0, openBalance: "0" }),
        payments: payments?.total ?? 0,
        needsReview: payments?.needsReview ?? 0,
      },
      documents: documents ?? { total: 0, needsReview: 0 },
    };
  }),

  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const practiceId = ctx.practiceId;
    const pattern = searchPattern(input.query);

    if (input.section === "contacts") {
      const filter = and(
        eq(clientContacts.practiceId, practiceId),
        isNull(clientContacts.deletedAt),
        input.query
          ? or(
              ilike(clientContacts.firstName, pattern),
              ilike(clientContacts.lastName, pattern),
              ilike(clientContacts.email, pattern),
              ilike(clients.firstName, pattern),
              ilike(clients.lastName, pattern),
            )
          : undefined,
      );
      const rows = await ctx.db
        .select({
          id: clientContacts.id,
          firstName: clientContacts.firstName,
          lastName: clientContacts.lastName,
          email: clientContacts.email,
          phone: clientContacts.phone,
          kind: clientContacts.kind,
          attributionStatus: clientContacts.attributionStatus,
          clientId: clients.id,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          createdAt: clientContacts.createdAt,
        })
        .from(clientContacts)
        .leftJoin(
          clients,
          and(
            eq(clientContacts.clientId, clients.id),
            eq(clients.practiceId, practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(filter)
        .orderBy(
          asc(clientContacts.lastName),
          asc(clientContacts.firstName),
          asc(clientContacts.id),
        )
        .limit(input.limit)
        .offset(input.offset);
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(clientContacts)
        .leftJoin(
          clients,
          and(
            eq(clientContacts.clientId, clients.id),
            eq(clients.practiceId, practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(filter);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title: fullName(row.firstName, row.lastName) || "Imported contact",
          subtitle: row.clientId
            ? `Co-owner for ${fullName(row.clientFirstName, row.clientLastName)}`
            : "Client match needs review",
          date: row.createdAt.toISOString(),
          status: row.kind.replaceAll("_", " "),
          patientId: null,
          clientId: row.clientId,
          amount: null,
          balance: null,
          fileUrl: null,
          needsReview: row.attributionStatus === "needs_review",
          meta: [row.email, row.phone].filter((item): item is string => !!item),
        })),
      };
    }

    if (input.section === "appointments") {
      const filter = and(
        eq(historicalAppointments.practiceId, practiceId),
        eq(patients.practiceId, practiceId),
        eq(clients.practiceId, practiceId),
        isNull(historicalAppointments.deletedAt),
        isNull(patients.deletedAt),
        isNull(clients.deletedAt),
        input.query
          ? or(
              ilike(patients.name, pattern),
              ilike(clients.firstName, pattern),
              ilike(clients.lastName, pattern),
              ilike(historicalAppointments.appointmentType, pattern),
              ilike(historicalAppointments.reason, pattern),
            )
          : undefined,
      );
      const base = ctx.db
        .select({
          id: historicalAppointments.id,
          patientId: patients.id,
          patientName: patients.name,
          clientId: clients.id,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          startedAt: historicalAppointments.startedAt,
          status: historicalAppointments.status,
          appointmentType: historicalAppointments.appointmentType,
          reason: historicalAppointments.reason,
        })
        .from(historicalAppointments)
        .innerJoin(
          patients,
          and(
            eq(historicalAppointments.patientId, patients.id),
            eq(patients.practiceId, practiceId),
          ),
        )
        .innerJoin(
          clients,
          and(
            eq(historicalAppointments.clientId, clients.id),
            eq(clients.practiceId, practiceId),
          ),
        );
      const rows = await base
        .where(filter)
        .orderBy(
          desc(historicalAppointments.startedAt),
          asc(historicalAppointments.id),
        )
        .limit(input.limit)
        .offset(input.offset);
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(historicalAppointments)
        .innerJoin(patients, eq(historicalAppointments.patientId, patients.id))
        .innerJoin(clients, eq(historicalAppointments.clientId, clients.id))
        .where(filter);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title: row.patientName,
          subtitle: row.appointmentType ?? row.reason ?? "Imported appointment",
          date: row.startedAt.toISOString(),
          status: row.status.replaceAll("_", " "),
          patientId: row.patientId,
          clientId: row.clientId,
          amount: null,
          balance: null,
          fileUrl: null,
          needsReview: false,
          meta: [fullName(row.clientFirstName, row.clientLastName)],
        })),
      };
    }

    if (input.section === "medications") {
      const filter = and(
        eq(externalPrescriptions.practiceId, practiceId),
        eq(patients.practiceId, practiceId),
        isNull(externalPrescriptions.deletedAt),
        isNull(patients.deletedAt),
        input.query
          ? or(
              ilike(patients.name, pattern),
              ilike(externalPrescriptions.medicationName, pattern),
              ilike(externalPrescriptions.directions, pattern),
            )
          : undefined,
      );
      const rows = await ctx.db
        .select({
          id: externalPrescriptions.id,
          patientId: patients.id,
          patientName: patients.name,
          clientId: patients.clientId,
          medicationName: externalPrescriptions.medicationName,
          directions: externalPrescriptions.directions,
          prescribedAt: externalPrescriptions.prescribedAt,
          createdAt: externalPrescriptions.createdAt,
          status: externalPrescriptions.status,
          reviewStatus: externalPrescriptions.reviewStatus,
          fillCount: sql<number>`(
            select count(*)::int from ${externalPrescriptionFills}
            where ${externalPrescriptionFills.practiceId} = ${practiceId}
              and ${externalPrescriptionFills.prescriptionId} = ${externalPrescriptions.id}
              and ${externalPrescriptionFills.deletedAt} is null
          )`,
        })
        .from(externalPrescriptions)
        .innerJoin(
          patients,
          and(
            eq(externalPrescriptions.patientId, patients.id),
            eq(patients.practiceId, practiceId),
          ),
        )
        .where(filter)
        .orderBy(
          desc(externalPrescriptions.prescribedAt),
          desc(externalPrescriptions.createdAt),
          asc(externalPrescriptions.id),
        )
        .limit(input.limit)
        .offset(input.offset);
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(externalPrescriptions)
        .innerJoin(patients, eq(externalPrescriptions.patientId, patients.id))
        .where(filter);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title: row.medicationName,
          subtitle: `${row.patientName} · ${row.fillCount} fill${row.fillCount === 1 ? "" : "s"}`,
          date: (row.prescribedAt ?? row.createdAt).toISOString(),
          status: row.status,
          patientId: row.patientId,
          clientId: row.clientId,
          amount: null,
          balance: null,
          fileUrl: null,
          needsReview: row.reviewStatus === "unreviewed",
          meta: row.directions ? [row.directions] : [],
        })),
      };
    }

    if (input.section === "labs") {
      const filter = and(
        eq(externalLabReports.practiceId, practiceId),
        isNull(externalLabReports.deletedAt),
        input.query
          ? or(
              ilike(patients.name, pattern),
              ilike(externalLabReports.orderName, pattern),
              ilike(externalLabReports.labName, pattern),
              ilike(externalLabReports.accessionNumber, pattern),
            )
          : undefined,
      );
      const rows = await ctx.db
        .select({
          id: externalLabReports.id,
          patientId: patients.id,
          patientName: patients.name,
          clientId: patients.clientId,
          orderName: externalLabReports.orderName,
          labName: externalLabReports.labName,
          orderedAt: externalLabReports.orderedAt,
          resultedAt: externalLabReports.resultedAt,
          createdAt: externalLabReports.createdAt,
          status: externalLabReports.status,
          attributionStatus: externalLabReports.attributionStatus,
          reviewStatus: externalLabReports.reviewStatus,
          accessionNumber: externalLabReports.accessionNumber,
        })
        .from(externalLabReports)
        .leftJoin(
          patients,
          and(
            eq(externalLabReports.patientId, patients.id),
            eq(patients.practiceId, practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .where(filter)
        .orderBy(
          desc(externalLabReports.resultedAt),
          desc(externalLabReports.orderedAt),
          desc(externalLabReports.createdAt),
          asc(externalLabReports.id),
        )
        .limit(input.limit)
        .offset(input.offset);
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(externalLabReports)
        .leftJoin(patients, eq(externalLabReports.patientId, patients.id))
        .where(filter);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title: row.orderName ?? row.labName ?? "Imported lab report",
          subtitle: row.patientName ?? "Patient match needs review",
          date: (
            row.resultedAt ??
            row.orderedAt ??
            row.createdAt
          ).toISOString(),
          status: row.status,
          patientId: row.patientId,
          clientId: row.clientId,
          amount: null,
          balance: null,
          fileUrl: null,
          needsReview:
            row.attributionStatus === "needs_review" ||
            row.reviewStatus === "unreviewed",
          meta: row.accessionNumber ? [`Accession ${row.accessionNumber}`] : [],
        })),
      };
    }

    if (input.section === "financial") {
      const filter = and(
        eq(legacyFinancialDocuments.practiceId, practiceId),
        eq(clients.practiceId, practiceId),
        isNull(legacyFinancialDocuments.deletedAt),
        isNull(clients.deletedAt),
        input.query
          ? or(
              ilike(clients.firstName, pattern),
              ilike(clients.lastName, pattern),
              ilike(patients.name, pattern),
              ilike(legacyFinancialDocuments.documentNumber, pattern),
            )
          : undefined,
      );
      const rows = await ctx.db
        .select({
          id: legacyFinancialDocuments.id,
          documentNumber: legacyFinancialDocuments.documentNumber,
          documentType: legacyFinancialDocuments.documentType,
          issuedAt: legacyFinancialDocuments.issuedAt,
          status: legacyFinancialDocuments.status,
          total: legacyFinancialDocuments.total,
          balance: legacyFinancialDocuments.balance,
          clientId: clients.id,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          patientId: patients.id,
          patientName: patients.name,
          lineCount: sql<number>`(
            select count(*)::int from ${legacyFinancialLineItems}
            where ${legacyFinancialLineItems.practiceId} = ${practiceId}
              and ${legacyFinancialLineItems.documentId} = ${legacyFinancialDocuments.id}
              and ${legacyFinancialLineItems.deletedAt} is null
          )`,
        })
        .from(legacyFinancialDocuments)
        .innerJoin(
          clients,
          and(
            eq(legacyFinancialDocuments.clientId, clients.id),
            eq(clients.practiceId, practiceId),
          ),
        )
        .leftJoin(
          patients,
          and(
            eq(legacyFinancialDocuments.patientId, patients.id),
            eq(patients.practiceId, practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .where(filter)
        .orderBy(
          desc(legacyFinancialDocuments.issuedAt),
          asc(legacyFinancialDocuments.id),
        )
        .limit(input.limit)
        .offset(input.offset);
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(legacyFinancialDocuments)
        .innerJoin(clients, eq(legacyFinancialDocuments.clientId, clients.id))
        .leftJoin(patients, eq(legacyFinancialDocuments.patientId, patients.id))
        .where(filter);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title:
            row.documentNumber ||
            `${row.documentType.replaceAll("_", " ")} · ${row.issuedAt.toLocaleDateString("en-US")}`,
          subtitle: `${fullName(row.clientFirstName, row.clientLastName)}${row.patientName ? ` · ${row.patientName}` : ""}`,
          date: row.issuedAt.toISOString(),
          status: row.status,
          patientId: row.patientId,
          clientId: row.clientId,
          amount: row.total,
          balance: row.balance,
          fileUrl: null,
          needsReview: false,
          meta: [`${row.lineCount} line${row.lineCount === 1 ? "" : "s"}`],
        })),
      };
    }

    const filter = and(
      eq(historicalDocuments.practiceId, practiceId),
      isNull(historicalDocuments.deletedAt),
      input.query
        ? or(
            ilike(historicalDocuments.title, pattern),
            ilike(patients.name, pattern),
          )
        : undefined,
    );
    const rows = await ctx.db
      .select({
        id: historicalDocuments.id,
        title: historicalDocuments.title,
        kind: historicalDocuments.kind,
        linkStatus: historicalDocuments.linkStatus,
        documentDate: historicalDocuments.documentDate,
        createdAt: historicalDocuments.createdAt,
        patientId: patients.id,
        patientName: patients.name,
        clientId: patients.clientId,
        fileUrl: files.fileUrl,
      })
      .from(historicalDocuments)
      .innerJoin(
        files,
        and(
          eq(historicalDocuments.fileId, files.id),
          eq(files.practiceId, practiceId),
        ),
      )
      .leftJoin(
        patients,
        and(
          eq(historicalDocuments.patientId, patients.id),
          eq(patients.practiceId, practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .where(filter)
      .orderBy(
        desc(historicalDocuments.documentDate),
        desc(historicalDocuments.createdAt),
        asc(historicalDocuments.id),
      )
      .limit(input.limit)
      .offset(input.offset);
    const [{ total }] = await ctx.db
      .select({ total: count() })
      .from(historicalDocuments)
      .innerJoin(files, eq(historicalDocuments.fileId, files.id))
      .leftJoin(patients, eq(historicalDocuments.patientId, patients.id))
      .where(filter);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.patientName ?? "Patient match needs review",
        date: row.documentDate
          ? `${row.documentDate}T12:00:00.000Z`
          : row.createdAt.toISOString(),
        status: row.kind.replaceAll("_", " "),
        patientId: row.patientId,
        clientId: row.clientId,
        amount: null,
        balance: null,
        fileUrl: row.fileUrl,
        needsReview: row.linkStatus === "needs_review",
        meta: [],
      })),
    };
  }),

  detail: protectedProcedure
    .input(z.object({ section: sectionInput, id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const practiceId = ctx.practiceId;
      if (input.section === "medications") {
        const [record] = await ctx.db
          .select({
            id: externalPrescriptions.id,
            medicationName: externalPrescriptions.medicationName,
            directions: externalPrescriptions.directions,
            quantity: externalPrescriptions.quantity,
            refillCount: externalPrescriptions.refillCount,
            prescribedAt: externalPrescriptions.prescribedAt,
            expiresAt: externalPrescriptions.expiresAt,
            status: externalPrescriptions.status,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(externalPrescriptions)
          .innerJoin(
            patients,
            and(
              eq(externalPrescriptions.patientId, patients.id),
              eq(patients.practiceId, practiceId),
            ),
          )
          .where(
            and(
              eq(externalPrescriptions.id, input.id),
              eq(externalPrescriptions.practiceId, practiceId),
              isNull(externalPrescriptions.deletedAt),
            ),
          )
          .limit(1);
        if (!record) throw new TRPCError({ code: "NOT_FOUND" });
        const entries = await ctx.db
          .select({
            id: externalPrescriptionFills.id,
            occurredAt: externalPrescriptionFills.filledAt,
            quantity: externalPrescriptionFills.quantityDispensed,
            detail: externalPrescriptionFills.directions,
            status: externalPrescriptionFills.sourceStatus,
          })
          .from(externalPrescriptionFills)
          .where(
            and(
              eq(externalPrescriptionFills.practiceId, practiceId),
              eq(externalPrescriptionFills.prescriptionId, record.id),
              isNull(externalPrescriptionFills.deletedAt),
            ),
          )
          .orderBy(desc(externalPrescriptionFills.filledAt));
        return { kind: "medications" as const, record, entries };
      }

      if (input.section === "labs") {
        const [record] = await ctx.db
          .select({
            id: externalLabReports.id,
            title: externalLabReports.orderName,
            labName: externalLabReports.labName,
            status: externalLabReports.status,
            orderedAt: externalLabReports.orderedAt,
            resultedAt: externalLabReports.resultedAt,
            summary: externalLabReports.summary,
            interpretation: externalLabReports.interpretation,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(externalLabReports)
          .leftJoin(
            patients,
            and(
              eq(externalLabReports.patientId, patients.id),
              eq(patients.practiceId, practiceId),
            ),
          )
          .where(
            and(
              eq(externalLabReports.id, input.id),
              eq(externalLabReports.practiceId, practiceId),
              isNull(externalLabReports.deletedAt),
            ),
          )
          .limit(1);
        if (!record) throw new TRPCError({ code: "NOT_FOUND" });
        const entries = await ctx.db
          .select({
            id: externalLabObservations.id,
            name: externalLabObservations.name,
            value: externalLabObservations.value,
            unit: externalLabObservations.unit,
            referenceRange: externalLabObservations.referenceRange,
            flag: externalLabObservations.flag,
          })
          .from(externalLabObservations)
          .where(
            and(
              eq(externalLabObservations.practiceId, practiceId),
              eq(externalLabObservations.reportId, record.id),
              isNull(externalLabObservations.deletedAt),
            ),
          )
          .orderBy(asc(externalLabObservations.sortOrder));
        return { kind: "labs" as const, record, entries };
      }

      if (input.section === "financial") {
        const [record] = await ctx.db
          .select({
            id: legacyFinancialDocuments.id,
            documentNumber: legacyFinancialDocuments.documentNumber,
            documentType: legacyFinancialDocuments.documentType,
            issuedAt: legacyFinancialDocuments.issuedAt,
            status: legacyFinancialDocuments.status,
            subtotal: legacyFinancialDocuments.subtotal,
            tax: legacyFinancialDocuments.tax,
            discount: legacyFinancialDocuments.discount,
            total: legacyFinancialDocuments.total,
            paidAmount: legacyFinancialDocuments.paidAmount,
            balance: legacyFinancialDocuments.balance,
            clientId: clients.id,
            clientName: sql<string>`${clients.firstName} || ' ' || ${clients.lastName}`,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(legacyFinancialDocuments)
          .innerJoin(
            clients,
            and(
              eq(legacyFinancialDocuments.clientId, clients.id),
              eq(clients.practiceId, practiceId),
            ),
          )
          .leftJoin(
            patients,
            and(
              eq(legacyFinancialDocuments.patientId, patients.id),
              eq(patients.practiceId, practiceId),
            ),
          )
          .where(
            and(
              eq(legacyFinancialDocuments.id, input.id),
              eq(legacyFinancialDocuments.practiceId, practiceId),
              isNull(legacyFinancialDocuments.deletedAt),
            ),
          )
          .limit(1);
        if (!record) throw new TRPCError({ code: "NOT_FOUND" });
        const [entries, allocations] = await Promise.all([
          ctx.db
            .select({
              id: legacyFinancialLineItems.id,
              description: legacyFinancialLineItems.description,
              quantity: legacyFinancialLineItems.quantity,
              unitPrice: legacyFinancialLineItems.unitPrice,
              total: legacyFinancialLineItems.total,
            })
            .from(legacyFinancialLineItems)
            .where(
              and(
                eq(legacyFinancialLineItems.practiceId, practiceId),
                eq(legacyFinancialLineItems.documentId, record.id),
                isNull(legacyFinancialLineItems.deletedAt),
              ),
            )
            .orderBy(asc(legacyFinancialLineItems.sortOrder)),
          ctx.db
            .select({
              id: legacyFinancialAllocations.id,
              amount: legacyFinancialAllocations.amount,
              allocatedAt: legacyFinancialAllocations.allocatedAt,
              paymentReceivedAt: legacyFinancialPayments.receivedAt,
              paymentMethod: legacyFinancialPayments.method,
            })
            .from(legacyFinancialAllocations)
            .innerJoin(
              legacyFinancialPayments,
              and(
                eq(
                  legacyFinancialAllocations.paymentId,
                  legacyFinancialPayments.id,
                ),
                eq(legacyFinancialPayments.practiceId, practiceId),
              ),
            )
            .where(
              and(
                eq(legacyFinancialAllocations.practiceId, practiceId),
                eq(legacyFinancialAllocations.documentId, record.id),
                isNull(legacyFinancialAllocations.deletedAt),
              ),
            )
            .orderBy(desc(legacyFinancialAllocations.allocatedAt)),
        ]);
        return { kind: "financial" as const, record, entries, allocations };
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This archive section has no expanded detail view.",
      });
    }),
});
