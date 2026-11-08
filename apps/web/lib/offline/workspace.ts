import { z } from "zod";
import { EncryptedDeviceVault, encryptedValueExists } from "./encrypted-vault";

export const WORKSPACE_DATABASE = "openvpm-offline-workspace-v1";
export const WORKSPACE_KEY = "encrypted-practice-workspace-v1";
export const OFFLINE_ACCESS_MS = 24 * 60 * 60 * 1000;
export const SOAP_FIELDS = [
  "subjective",
  "objective",
  "assessment",
  "plan",
] as const;
const uuid = z.string().uuid();
const text = z.string().max(10_000);
export const soapSectionsSchema = z
  .object({ subjective: text, objective: text, assessment: text, plan: text })
  .strict();
export type OfflineSoapSections = z.infer<typeof soapSectionsSchema>;
export const identitySchema = z
  .object({
    userId: uuid,
    practiceId: uuid,
    userName: z.string().max(256),
    practiceName: z.string().max(256),
    authorizedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    enabled: z.boolean(),
  })
  .strict();
export const soapRequestSchema = z
  .object({
    patientId: uuid,
    appointmentId: uuid,
    noteId: uuid.nullable(),
    expectedRevision: z.number().int().min(0),
    sections: soapSectionsSchema,
  })
  .strict();
export const chartSnapshotSchema = z
  .object({
    patient: z
      .object({
        id: uuid,
        name: z.string().max(128),
        species: z.string().max(40),
        breed: z.string().max(128).nullable(),
        sex: z.string().max(40).nullable(),
        dob: z.string().nullable(),
      })
      .strict(),
    capturedAt: z.string().datetime(),
    allergies: z
      .array(
        z
          .object({
            allergen: z.string().max(255),
            reaction: text.nullable(),
            severity: z.string().max(40),
          })
          .strict(),
      )
      .max(50),
    notes: z
      .array(
        z
          .object({
            content: z.string().max(20_000),
            type: z.string().max(40),
            at: z.string().datetime(),
          })
          .strict(),
      )
      .max(20),
    soapHistory: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            author: z.string().max(256),
            sections: soapSectionsSchema,
          })
          .strict(),
      )
      .max(5),
    visit: z
      .object({
        appointmentId: uuid,
        startTime: z.string().datetime(),
        noteId: uuid.nullable(),
        revision: z.number().int().min(0),
        sections: soapSectionsSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ChartSnapshot = z.infer<typeof chartSnapshotSchema>;
export const offlineChartSchema = z
  .object({
    key: z.string().max(80),
    snapshot: chartSnapshotSchema,
    sections: soapSectionsSchema,
    baseline: soapSectionsSchema,
    pending: soapRequestSchema.nullable(),
    conflict: z
      .object({
        kind: z.enum(["conflict", "already_finalized"]),
        sections: soapSectionsSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OfflineChart = z.infer<typeof offlineChartSchema>;
export const workspaceSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    charts: z.array(offlineChartSchema).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const chart of value.charts) {
      const expected = chartKey(chart.snapshot);
      if (chart.key !== expected || keys.has(expected))
        ctx.addIssue({
          code: "custom",
          message: "Invalid saved chart identity.",
        });
      keys.add(expected);
      if (
        chart.pending &&
        (chart.pending.patientId !== chart.snapshot.patient.id ||
          chart.pending.appointmentId !== chart.snapshot.visit?.appointmentId ||
          chart.pending.noteId !== chart.snapshot.visit?.noteId ||
          chart.pending.expectedRevision !== chart.snapshot.visit?.revision ||
          !sameSections(chart.pending.sections, chart.sections))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid pending visit identity.",
        });
      }
    }
  });
export type OfflineWorkspace = z.infer<typeof workspaceSchema>;
export type WorkspaceIdentity = z.infer<typeof identitySchema>;
export const EMPTY_SOAP: OfflineSoapSections = {
  subjective: "",
  objective: "",
  assessment: "",
  plan: "",
};
export function sameSections(a: OfflineSoapSections, b: OfflineSoapSections) {
  return SOAP_FIELDS.every((key) => a[key] === b[key]);
}
export function chartKey(snapshot: ChartSnapshot) {
  return `${snapshot.patient.id}:${snapshot.visit?.appointmentId ?? "chart"}`;
}
export function chartHasChanges(chart: OfflineChart) {
  return Boolean(
    chart.pending ||
    chart.conflict ||
    !sameSections(chart.sections, chart.baseline),
  );
}
export function hasWorkspaceChanges(workspace: OfflineWorkspace) {
  return workspace.charts.some(chartHasChanges);
}
export function sameIdentity(a: WorkspaceIdentity, b: WorkspaceIdentity) {
  return a.userId === b.userId && a.practiceId === b.practiceId;
}
export function offlineAccessValid(
  identity: WorkspaceIdentity,
  now = Date.now(),
) {
  const start = Date.parse(identity.authorizedAt),
    end = Date.parse(identity.expiresAt);
  return now >= start && now < end && end - start <= OFFLINE_ACCESS_MS;
}
export function addPreparedChart(
  workspace: OfflineWorkspace,
  snapshot: ChartSnapshot,
  identity: WorkspaceIdentity,
): OfflineWorkspace {
  if (!sameIdentity(workspace.identity, identity))
    throw new Error("Sign in as the person who prepared this workspace.");
  const key = chartKey(snapshot),
    existing = workspace.charts.find((chart) => chart.key === key);
  if (existing && chartHasChanges(existing))
    throw new Error(
      "Save or resolve the local visit note before refreshing this chart. Your text has been kept.",
    );
  if (!existing && workspace.charts.length >= 20)
    throw new Error(
      "This workspace holds up to 20 charts. Remove a saved chart before adding another.",
    );
  const sections = snapshot.visit?.sections ?? { ...EMPTY_SOAP };
  return workspaceSchema.parse({
    ...workspace,
    identity,
    charts: [
      ...workspace.charts.filter((chart) => chart.key !== key),
      {
        key,
        snapshot,
        sections,
        baseline: sections,
        pending: null,
        conflict: null,
      },
    ],
  });
}
export function beginSoapSync(chart: OfflineChart): OfflineChart {
  if (!chart.snapshot.visit)
    throw new Error(
      "Prepare an in-exam visit online before writing a SOAP note.",
    );
  if (chart.conflict)
    throw new Error("Resolve the server conflict in the online visit editor.");
  if (chart.pending) return chart;
  return {
    ...chart,
    pending: {
      patientId: chart.snapshot.patient.id,
      appointmentId: chart.snapshot.visit.appointmentId,
      noteId: chart.snapshot.visit.noteId,
      expectedRevision: chart.snapshot.visit.revision,
      sections: { ...chart.sections },
    },
  };
}
export function completeSoapSync(
  chart: OfflineChart,
  result:
    | { outcome: "saved"; noteId: string; revision: number }
    | {
        outcome: "conflict" | "already_finalized";
        sections: OfflineSoapSections;
      },
): OfflineChart {
  if (!chart.pending || !chart.snapshot.visit)
    throw new Error("No pending visit save.");
  if (result.outcome !== "saved")
    return {
      ...chart,
      conflict: { kind: result.outcome, sections: result.sections },
    };
  return {
    ...chart,
    snapshot: {
      ...chart.snapshot,
      visit: {
        ...chart.snapshot.visit,
        noteId: result.noteId,
        revision: result.revision,
        sections: chart.pending.sections,
      },
    },
    baseline: chart.pending.sections,
    sections: chart.pending.sections,
    pending: null,
    conflict: null,
  };
}
const options = {
  database: WORKSPACE_DATABASE,
  storageKey: WORKSPACE_KEY,
  validate: (value: unknown) => workspaceSchema.parse(value),
  maxBytes: 7_999_984,
};
export function workspaceExists(factory?: IDBFactory) {
  return encryptedValueExists({ ...options, factory });
}
export function openWorkspace(passphrase: string, factory?: IDBFactory) {
  return EncryptedDeviceVault.open({ ...options, factory }, passphrase);
}
