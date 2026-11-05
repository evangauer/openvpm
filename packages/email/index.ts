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
export type { FirstClinicWinEmailProps } from "./src/templates/FirstClinicWinEmail";
export type { CheckoutRecoveryEmailProps } from "./src/templates/CheckoutRecoveryEmail";
export type { DemoFollowupEmailProps } from "./src/templates/DemoFollowupEmail";
export type { TrialUsage } from "./src/templates/TrialEndingEmail";
export type { TeamInviteEmailProps } from "./src/templates/TeamInviteEmail";
export type { TrialWinbackEmailProps } from "./src/templates/TrialWinbackEmail";
export type { AdoptionEmailProps, AdoptionTip } from "./src/templates/AdoptionEmail";
export type { NpsSurveyEmailProps } from "./src/templates/NpsSurveyEmail";
