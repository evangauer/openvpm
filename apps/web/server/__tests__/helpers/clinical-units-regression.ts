import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { practices, users } from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import {
  weightInputKilograms,
  temperatureInputCelsius,
} from "@/lib/clinical-units";
import { settingsRouter } from "../../routers/settings";
import { recordsRouter } from "../../routers/records";
import { patientsRouter } from "../../routers/patients";
import { vitalsRouter } from "../../routers/vitals";
import type { runGoldenClinic } from "./golden-clinic";

/** Real SQL proves atomic preference patches, role/tenant isolation and metric persistence. */
export async function runClinicalUnitsRegression(
  clinic: Awaited<ReturnType<typeof runGoldenClinic>>,
) {
  const ctx = clinic.context();
  const settings = settingsRouter.createCaller(ctx);
  const legacy = {
    ambulatoryWorkspace: { enabled: false, measurementSystem: "us_customary" },
    unrelated: { keep: "sentinel" },
  };
  await withTenant(ctx.db, clinic.practice.id, (tx) =>
    tx
      .update(practices)
      .set({ settings: legacy })
      .where(eq(practices.id, clinic.practice.id)),
  );
  const imperial = {
    weightEntryUnit: "lb",
    temperatureUnit: "F",
    dualDisplay: true,
  } as const;
  expect(await settings.getClinicalUnits()).toEqual(imperial);

  const [technician] = await withTenant(ctx.db, clinic.practice.id, (tx) =>
    tx
      .insert(users)
      .values({
        practiceId: clinic.practice.id,
        role: "technician",
        name: "Synthetic Unit Technician",
        email: "units-technician@example.invalid",
        passwordHash: "synthetic-not-a-login",
      })
      .returning(),
  );
  const staff = settingsRouter.createCaller(clinic.context(technician!));
  expect(await staff.getClinicalUnits()).toEqual(imperial);
  await expect(staff.updateClinicalUnits(imperial)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    settings.updateClinicalUnits({
      ...imperial,
      weightEntryUnit: "stone",
    } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    settings.updateClinicalUnits({
      ...imperial,
      practiceId: clinic.foreignDoctor.practiceId,
    } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const metric = {
    weightEntryUnit: "g",
    temperatureUnit: "C",
    dualDisplay: false,
  } as const;
  await Promise.all([
    settings.updateClinicalUnits(metric),
    settings.updatePractice({ name: "Synthetic Units Clinic" }),
  ]);
  const practice = await settings.getPractice();
  expect(practice.name).toBe("Synthetic Units Clinic");
  expect(practice.settings).toMatchObject({ ...legacy, units: metric });
  expect(await staff.getClinicalUnits()).toEqual(metric);
  expect(
    await recordsRouter.createCaller(clinic.context(technician!)).settings(),
  ).toMatchObject({ units: metric });
  expect(
    await settingsRouter
      .createCaller(clinic.context(clinic.foreignDoctor))
      .getClinicalUnits(),
  ).toEqual({ weightEntryUnit: "kg", temperatureUnit: "C", dualDisplay: true });

  await settings.updateClinicalUnits(imperial);
  const patients = patientsRouter.createCaller(ctx);
  await patients.addWeight({
    patientId: clinic.patient.id,
    weightKg: weightInputKilograms("26", "lb")!,
  });
  expect(
    (await patients.getById({ id: clinic.patient.id })).weights[0]?.weightKg,
  ).toBe("11.793");
  const vitals = vitalsRouter.createCaller(ctx);
  const recorded = await vitals.record({
    patientId: clinic.patient.id,
    weightKg: Number(weightInputKilograms("26", "lb", 200)),
    temperatureC: temperatureInputCelsius("101.5", "F")!,
  });
  expect(recorded).toMatchObject({ weightKg: "11.793", temperatureC: "38.6" });
  // Public API remains explicitly metric; preferences do not alter validation.
  await expect(
    vitals.record({ patientId: clinic.patient.id, temperatureC: 101.5 }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    patients.addWeight({ patientId: clinic.patient.id, weightKg: "0.0001" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
}
