import { createRouter } from "../trpc";
import { authRouter } from "./auth";
import { clientsRouter } from "./clients";
import { patientsRouter } from "./patients";
import { appointmentsRouter } from "./appointments";
import { recordsRouter } from "./records";
import { billingRouter } from "./billing";
import { dashboardRouter } from "./dashboard";
import { whiteboardRouter } from "./whiteboard";
import { reportsRouter } from "./reports";
import { portalRouter } from "./portal";
import { settingsRouter } from "./settings";
import { communicationsRouter } from "./communications";
import { inventoryRouter } from "./inventory";
import { dataRouter } from "./data";
import { aiRouter } from "./ai";
import { webhooksRouter } from "./webhooks";
import { notificationsRouter } from "./notifications";
import { encountersRouter } from "./encounters";
import { templatesRouter } from "./templates";
import { controlledSubstancesRouter } from "./controlled-substances";
import { insuranceRouter } from "./insurance";
import { apiKeysRouter } from "./api-keys";
import { dosingRouter } from "./dosing";
import { vitalsRouter } from "./vitals";
import { agentRouter } from "./agent";
import { treatmentPlansRouter } from "./treatment-plans";
import { wellnessRouter } from "./wellness";
import { waitlistRouter } from "./waitlist";
import { subscriptionRouter } from "./subscription";
import { adminRouter } from "./admin";
import { messagingRouter } from "./messaging";
import { bookingRouter } from "./booking";
import { careRemindersRouter } from "./care-reminders";
import { migrationArchiveRouter } from "./migration-archive";
import { visitTreatmentPlansRouter } from "./visit-treatment-plans";

export const appRouter = createRouter({
  auth: authRouter,
  clients: clientsRouter,
  patients: patientsRouter,
  appointments: appointmentsRouter,
  records: recordsRouter,
  billing: billingRouter,
  dashboard: dashboardRouter,
  whiteboard: whiteboardRouter,
  reports: reportsRouter,
  portal: portalRouter,
  settings: settingsRouter,
  communications: communicationsRouter,
  inventory: inventoryRouter,
  data: dataRouter,
  ai: aiRouter,
  webhooks: webhooksRouter,
  notifications: notificationsRouter,
  encounters: encountersRouter,
  templates: templatesRouter,
  controlledSubstances: controlledSubstancesRouter,
  insurance: insuranceRouter,
  apiKeys: apiKeysRouter,
  dosing: dosingRouter,
  vitals: vitalsRouter,
  agent: agentRouter,
  treatmentPlans: treatmentPlansRouter,
  wellness: wellnessRouter,
  waitlist: waitlistRouter,
  subscription: subscriptionRouter,
  admin: adminRouter,
  messaging: messagingRouter,
  booking: bookingRouter,
  careReminders: careRemindersRouter,
  migrationArchive: migrationArchiveRouter,
  visitTreatmentPlans: visitTreatmentPlansRouter,
});

export type AppRouter = typeof appRouter;
