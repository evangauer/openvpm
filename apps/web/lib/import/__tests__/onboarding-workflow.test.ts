import { describe, expect, it } from "vitest";
import {
  isOnboardingImportModeLocked,
  isOnboardingMigrationSourceLocked,
  lastCommittedImportIndex,
  nextOnboardingImportMode,
  onboardingImportChangeCount,
  summarizeOnboardingImports,
  type OnboardingImportCommits,
  type OnboardingImportSelections,
} from "../onboarding-workflow";

const emptySelection = (): OnboardingImportSelections => ({
  clients: false,
  patients: false,
  vaccinations: false,
  soapNotes: false,
});

describe("onboarding migration workflow", () => {
  it("processes only supplied files in dependency order", () => {
    const selected = {
      ...emptySelection(),
      soapNotes: true,
      patients: true,
      vaccinations: true,
    };
    const committed: OnboardingImportCommits = {};

    expect(nextOnboardingImportMode(selected, committed)).toBe("patients");
    committed.patients = { imported: 2, reconciled: 0, errors: [] };
    expect(nextOnboardingImportMode(selected, committed)).toBe("vaccinations");
    committed.vaccinations = { imported: 3, reconciled: 0, errors: [] };
    expect(nextOnboardingImportMode(selected, committed)).toBe("soapNotes");
    committed.soapNotes = { imported: 4, reconciled: 0, errors: [] };
    expect(nextOnboardingImportMode(selected, committed)).toBeNull();
  });

  it("treats a reviewed zero-change stage as complete", () => {
    const selected = {
      ...emptySelection(),
      clients: true,
      patients: true,
    };
    const committed: OnboardingImportCommits = {
      clients: { imported: 0, reconciled: 0, errors: ["duplicate"] },
    };

    expect(nextOnboardingImportMode(selected, committed)).toBe("patients");
    expect(isOnboardingMigrationSourceLocked(false, committed)).toBe(false);
  });

  it("locks the source for prior or current-session material changes", () => {
    expect(isOnboardingMigrationSourceLocked(true, {})).toBe(true);
    expect(
      isOnboardingMigrationSourceLocked(false, {
        patients: { imported: 0, reconciled: 1, errors: [] },
      }),
    ).toBe(true);
  });

  it("freezes committed and skipped upstream stages but leaves later fixes open", () => {
    const committed: OnboardingImportCommits = {
      patients: { imported: 2, reconciled: 0, errors: [] },
    };

    expect(lastCommittedImportIndex(committed)).toBe(1);
    expect(isOnboardingImportModeLocked("clients", committed, false)).toBe(
      true,
    );
    expect(isOnboardingImportModeLocked("patients", committed, false)).toBe(
      true,
    );
    expect(isOnboardingImportModeLocked("vaccinations", committed, false)).toBe(
      false,
    );
    expect(isOnboardingImportModeLocked("soapNotes", committed, true)).toBe(
      true,
    );
  });

  it("summarizes partial commits without dropping earlier issues", () => {
    const summary = summarizeOnboardingImports({
      clients: { imported: 3, reconciled: 1, errors: ["client issue"] },
      patients: { imported: 2, reconciled: 2, errors: [] },
      vaccinations: {
        imported: 4,
        reconciled: 0,
        errors: ["vaccine issue"],
      },
    });

    expect(summary).toEqual({
      imported: {
        clients: 3,
        patients: 2,
        vaccinations: 4,
        soapNotes: 0,
      },
      reconciled: 3,
      errors: ["client issue", "vaccine issue"],
    });
    expect(onboardingImportChangeCount(summary)).toBe(12);
  });
});
