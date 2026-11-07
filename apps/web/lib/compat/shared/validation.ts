import { z } from "zod";

const uuidSchema = z.string().guid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
