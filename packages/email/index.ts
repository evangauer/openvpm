// @openpims/email — branded transactional email templates (React Email).
// Transport + send logic lives in the app; this package only renders HTML.
export { openvpmBrand } from "./src/brand";
export type { Brand } from "./src/brand";
export { theme } from "./src/theme";
export * from "./src/render";
export type { WelcomeEmailProps } from "./src/templates/WelcomeEmail";
export type { TrialEndingEmailProps } from "./src/templates/TrialEndingEmail";
export type { SetupRecoveryEmailProps } from "./src/templates/SetupRecoveryEmail";
export type { PaymentReceiptEmailProps } from "./src/templates/PaymentReceiptEmail";
export type { PaymentFailedEmailProps } from "./src/templates/PaymentFailedEmail";
