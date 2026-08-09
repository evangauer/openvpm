import { MIGRATION_STEPS, type MigrationImportMode } from "./sources";

export type OnboardingImportCommit = {
  imported: number;
  reconciled: number;
  errors: string[];
};

export type OnboardingImportCommits = Partial<
  Record<MigrationImportMode, OnboardingImportCommit>
>;

export type OnboardingImportSelections = Record<MigrationImportMode, boolean>;

export function nextOnboardingImportMode(
  selectedByMode: OnboardingImportSelections,
  committedByMode: OnboardingImportCommits,
): MigrationImportMode | null {
  return (
    MIGRATION_STEPS.find(
      ({ mode }) => selectedByMode[mode] && !committedByMode[mode],
    )?.mode ?? null
  );
}

export function lastCommittedImportIndex(
  committedByMode: OnboardingImportCommits,
): number {
  return MIGRATION_STEPS.reduce(
    (last, { mode }, index) =>
      committedByMode[mode] ? Math.max(last, index) : last,
    -1,
  );
}

export function isOnboardingMigrationSourceLocked(
  latestSourceHasCommittedChanges: boolean,
  committedByMode: OnboardingImportCommits,
): boolean {
  return (
    latestSourceHasCommittedChanges ||
    MIGRATION_STEPS.some(({ mode }) => {
      const committed = committedByMode[mode];
      return Boolean(
        committed && committed.imported + committed.reconciled > 0,
      );
    })
  );
}

/**
 * Once a stage commits, it and every skipped stage before it stay frozen.
 * Later stages remain editable so a clinic can fix a history file without
 * losing owner and patient work that already succeeded.
 */
export function isOnboardingImportModeLocked(
  mode: MigrationImportMode,
  committedByMode: OnboardingImportCommits,
  finished: boolean,
): boolean {
  if (finished) return true;
  const index = MIGRATION_STEPS.findIndex((step) => step.mode === mode);
  return index <= lastCommittedImportIndex(committedByMode);
}

export type OnboardingImportSummary = {
  imported: Record<MigrationImportMode, number>;
  reconciled: number;
  errors: string[];
};

export function summarizeOnboardingImports(
  committedByMode: OnboardingImportCommits,
): OnboardingImportSummary {
  const imported = Object.fromEntries(
    MIGRATION_STEPS.map(({ mode }) => [
      mode,
      committedByMode[mode]?.imported ?? 0,
    ]),
  ) as Record<MigrationImportMode, number>;

  return {
    imported,
    reconciled: MIGRATION_STEPS.reduce(
      (count, { mode }) => count + (committedByMode[mode]?.reconciled ?? 0),
      0,
    ),
    errors: MIGRATION_STEPS.flatMap(
      ({ mode }) => committedByMode[mode]?.errors ?? [],
    ),
  };
}

export function onboardingImportChangeCount(
  summary: OnboardingImportSummary,
): number {
  return (
    Object.values(summary.imported).reduce((total, count) => total + count, 0) +
    summary.reconciled
  );
}
