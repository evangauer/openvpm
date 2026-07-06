import { z } from "zod";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./auth-password-policy";

export { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH };

export const authPasswordInput = z
  .string()
  .min(
    AUTH_PASSWORD_MIN_LENGTH,
    `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`
  )
  .max(
    AUTH_PASSWORD_MAX_LENGTH,
    `Password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters.`
  );
