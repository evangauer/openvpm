import { z } from "zod";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const nonnegativeIntegerColumnInput = z
  .number()
  .int()
  .min(0)
  .max(POSTGRES_INTEGER_MAX);

export const positiveIntegerColumnInput = z
  .number()
  .int()
  .min(1)
  .max(POSTGRES_INTEGER_MAX);

export const integerColumnDeltaInput = z
  .number()
  .int()
  .min(-POSTGRES_INTEGER_MAX)
  .max(POSTGRES_INTEGER_MAX);
