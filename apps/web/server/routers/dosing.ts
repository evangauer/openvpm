import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  FORMULARY,
  DOSING_DISCLAIMER,
  DOSING_WEIGHT_MAX_KG,
  FORMULARY_DRUG_ID_MAX_LENGTH,
  calculateDose,
  isFormularyDrugId,
} from "@/lib/dosing";

const formularyDrugIdInput = z
  .string()
  .trim()
  .min(1, "Drug is required.")
  .max(
    FORMULARY_DRUG_ID_MAX_LENGTH,
    `Drug ID must be at most ${FORMULARY_DRUG_ID_MAX_LENGTH} characters.`
  )
  .refine(isFormularyDrugId, "Drug must be in the formulary.");

export const dosingRouter = createRouter({
  /** List the formulary for a drug picker. */
  formulary: protectedProcedure.query(() => {
    return {
      disclaimer: DOSING_DISCLAIMER,
      drugs: FORMULARY.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        species: d.doses.map((dose) => dose.species),
        concentrationsMgPerMl: d.concentrationsMgPerMl ?? [],
        tabletStrengthsMg: d.tabletStrengthsMg ?? [],
      })),
    };
  }),

  /** Calculate a weight-based dose range. */
  calculate: protectedProcedure
    .input(
      z.object({
        drugId: formularyDrugIdInput,
        species: z.enum(["canine", "feline"]),
        weightKg: z.number().finite().positive().max(DOSING_WEIGHT_MAX_KG),
        concentrationMgPerMl: z.number().finite().positive().optional(),
      })
    )
    .query(({ input }) => {
      try {
        return calculateDose(input);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: e instanceof Error ? e.message : "Unable to calculate dose",
        });
      }
    }),
});
