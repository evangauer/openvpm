import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";
import { loadPatientImportedChart } from "../patient-imported-history";

export const patientImportedHistoryRouter = createRouter({
  chart: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const chart = await loadPatientImportedChart(
        ctx.db,
        ctx.practiceId,
        input.patientId,
      );
      if (!chart) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
      }
      return chart;
    }),
});
