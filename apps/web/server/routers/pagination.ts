import { z } from "zod";

export const LIST_OFFSET_MAX = 100_000;

export const listOffsetInput = z
  .number()
  .int()
  .min(0)
  .max(LIST_OFFSET_MAX)
  .default(0);
