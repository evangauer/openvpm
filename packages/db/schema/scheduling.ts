import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  date,
  time,
  check,
  foreignKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { locations } from "./practices";
import { users } from "./users";
import { clients } from "./clients";
import { patients } from "./patients";

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
  "checked_out",
  "no_show",
  "cancelled",
]);

export const roomTypeEnum = pgEnum("room_type", [
  "exam",
  "surgery",
  "treatment",
  "boarding",
]);

export const recurringFrequencyEnum = pgEnum("recurring_frequency", [
  "weekly",
  "monthly",
  "annual",
]);

export const waitlistStatusEnum = pgEnum("waitlist_status", [
  "waiting",
  "scheduled",
  "cancelled",
]);

export const appointmentTypes = pgTable(
  "appointment_types",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: varchar("name", { length: 128 }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    color: varchar("color", { length: 7 }).default("#0d9488"),
    requiresDoctor: integer("requires_doctor").notNull().default(1),
    defaultRoomType: roomTypeEnum("default_room_type").default("exam"),
  },
  (table) => ({
    practiceNameIdx: index("appointment_types_practice_name_idx").on(
      table.practiceId,
      table.deletedAt,
      table.name,
    ),
  }),
);

export const rooms = pgTable(
  "rooms",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    name: varchar("name", { length: 128 }).notNull(),
    type: roomTypeEnum("type").notNull().default("exam"),
  },
  (table) => ({
    practiceNameIdx: index("rooms_practice_name_idx").on(
      table.practiceId,
      table.deletedAt,
      table.name,
    ),
    locationIdx: index("rooms_location_idx").on(
      table.practiceId,
      table.locationId,
      table.deletedAt,
    ),
    practiceLocationIdUq: uniqueIndex("rooms_practice_location_id_uq").on(
      table.practiceId,
      table.locationId,
      table.id,
    ),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "rooms_location_tenant_fk",
    }),
  }),
);

export const recurringSeries = pgTable("recurring_series", {
  ...baseColumns(),
  practiceId: uuid("practice_id")
    .notNull()
    .references(() => practices.id),
  frequency: recurringFrequencyEnum("frequency").notNull(),
  interval: integer("interval").notNull().default(1),
  endDate: date("end_date"),
});

export const appointments = pgTable(
  "appointments",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    typeId: uuid("type_id").references(() => appointmentTypes.id),
    patientId: uuid("patient_id").references(() => patients.id),
    clientId: uuid("client_id").references(() => clients.id),
    doctorId: uuid("doctor_id").references(() => users.id),
    roomId: uuid("room_id").references(() => rooms.id),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    notes: text("notes"),
    recurringSeriesId: uuid("recurring_series_id").references(
      () => recurringSeries.id,
    ),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("appointments_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practicePatientIdUq: uniqueIndex("appointments_practice_patient_id_uq").on(
      table.practiceId,
      table.id,
      table.patientId,
    ),
    practicePatientClientIdUq: uniqueIndex(
      "appointments_practice_patient_client_id_uq",
    ).on(table.practiceId, table.id, table.patientId, table.clientId),
    practiceTimeIdx: index("appointments_practice_time_idx").on(
      table.practiceId,
      table.startTime,
      table.doctorId,
    ),
    conversionCreatedIdx: index("appointments_conversion_created_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    patientIdx: index("appointments_patient_idx").on(table.patientId),
    doctorIdx: index("appointments_doctor_idx").on(
      table.doctorId,
      table.startTime,
    ),
    clientStatusIdx: index("appointments_client_status_idx").on(
      table.practiceId,
      table.clientId,
      table.status,
      table.deletedAt,
    ),
    patientStatusIdx: index("appointments_patient_status_idx").on(
      table.practiceId,
      table.patientId,
      table.status,
      table.deletedAt,
    ),
    doctorStatusIdx: index("appointments_doctor_status_idx").on(
      table.practiceId,
      table.doctorId,
      table.status,
      table.deletedAt,
    ),
    typeStatusIdx: index("appointments_type_status_idx").on(
      table.practiceId,
      table.typeId,
      table.status,
      table.deletedAt,
    ),
    roomStatusIdx: index("appointments_room_status_idx").on(
      table.practiceId,
      table.roomId,
      table.status,
      table.deletedAt,
    ),
    locationTimeIdx: index("appointments_location_time_idx").on(
      table.practiceId,
      table.locationId,
      table.startTime,
      table.deletedAt,
    ),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "appointments_location_tenant_fk",
    }),
    roomLocationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId, table.roomId],
      foreignColumns: [rooms.practiceId, rooms.locationId, rooms.id],
      name: "appointments_room_location_tenant_fk",
    }),
    timeRangeCheck: check(
      "appointments_time_range_check",
      sql`${table.startTime} < ${table.endTime}`,
    ),
  }),
);

export const appointmentWaitlist = pgTable(
  "appointment_waitlist",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    patientId: uuid("patient_id").references(() => patients.id),
    typeId: uuid("type_id").references(() => appointmentTypes.id),
    status: waitlistStatusEnum("status").notNull().default("waiting"),
    // Optional date window the client is available within.
    preferredFrom: date("preferred_from"),
    preferredTo: date("preferred_to"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (table) => ({
    practiceIdx: index("waitlist_practice_idx").on(
      table.practiceId,
      table.status,
    ),
    clientStatusIdx: index("waitlist_client_status_idx").on(
      table.practiceId,
      table.clientId,
      table.status,
      table.deletedAt,
    ),
    patientStatusIdx: index("waitlist_patient_status_idx").on(
      table.practiceId,
      table.patientId,
      table.status,
      table.deletedAt,
    ),
  }),
);

export const staffSchedules = pgTable(
  "staff_schedules",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    dayOfWeek: integer("day_of_week").notNull(), // 0=Sun, 6=Sat
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    locationId: uuid("location_id").references(() => locations.id),
  },
  (table) => ({
    activeDayIdx: index("staff_schedules_active_day_idx")
      .on(table.practiceId, table.locationId, table.dayOfWeek, table.userId)
      .where(sql`${table.deletedAt} is null`),
    activeWindowUq: uniqueIndex("staff_schedules_active_window_uq")
      .on(
        table.practiceId,
        table.userId,
        table.locationId,
        table.dayOfWeek,
        table.startTime,
        table.endTime,
      )
      .where(
        sql`${table.deletedAt} is null and ${table.locationId} is not null`,
      ),
    activeNullLocationWindowUq: uniqueIndex(
      "staff_schedules_active_null_location_window_uq",
    )
      .on(
        table.practiceId,
        table.userId,
        table.dayOfWeek,
        table.startTime,
        table.endTime,
      )
      .where(sql`${table.deletedAt} is null and ${table.locationId} is null`),
    locationIdx: index("staff_schedules_location_idx").on(
      table.practiceId,
      table.locationId,
      table.deletedAt,
    ),
    userIdx: index("staff_schedules_user_idx").on(
      table.practiceId,
      table.userId,
      table.deletedAt,
    ),
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "staff_schedules_user_tenant_fk",
    }),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "staff_schedules_location_tenant_fk",
    }),
    dayOfWeekCheck: check(
      "staff_schedules_day_of_week_check",
      sql`${table.dayOfWeek} between 0 and 6`,
    ),
    timeRangeCheck: check(
      "staff_schedules_time_range_check",
      sql`${table.startTime} < ${table.endTime}`,
    ),
  }),
);

// Relations
export const appointmentTypesRelations = relations(
  appointmentTypes,
  ({ one }) => ({
    practice: one(practices, {
      fields: [appointmentTypes.practiceId],
      references: [practices.id],
    }),
  }),
);

export const roomsRelations = relations(rooms, ({ one }) => ({
  practice: one(practices, {
    fields: [rooms.practiceId],
    references: [practices.id],
  }),
  location: one(locations, {
    fields: [rooms.locationId],
    references: [locations.id],
  }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  practice: one(practices, {
    fields: [appointments.practiceId],
    references: [practices.id],
  }),
  location: one(locations, {
    fields: [appointments.locationId],
    references: [locations.id],
  }),
  type: one(appointmentTypes, {
    fields: [appointments.typeId],
    references: [appointmentTypes.id],
  }),
  patient: one(patients, {
    fields: [appointments.patientId],
    references: [patients.id],
  }),
  client: one(clients, {
    fields: [appointments.clientId],
    references: [clients.id],
  }),
  doctor: one(users, {
    fields: [appointments.doctorId],
    references: [users.id],
  }),
  room: one(rooms, {
    fields: [appointments.roomId],
    references: [rooms.id],
  }),
  recurringSeries: one(recurringSeries, {
    fields: [appointments.recurringSeriesId],
    references: [recurringSeries.id],
  }),
}));

export const staffSchedulesRelations = relations(staffSchedules, ({ one }) => ({
  practice: one(practices, {
    fields: [staffSchedules.practiceId],
    references: [practices.id],
  }),
  user: one(users, {
    fields: [staffSchedules.userId],
    references: [users.id],
  }),
  location: one(locations, {
    fields: [staffSchedules.locationId],
    references: [locations.id],
  }),
}));

export const appointmentWaitlistRelations = relations(
  appointmentWaitlist,
  ({ one }) => ({
    practice: one(practices, {
      fields: [appointmentWaitlist.practiceId],
      references: [practices.id],
    }),
    client: one(clients, {
      fields: [appointmentWaitlist.clientId],
      references: [clients.id],
    }),
    patient: one(patients, {
      fields: [appointmentWaitlist.patientId],
      references: [patients.id],
    }),
    type: one(appointmentTypes, {
      fields: [appointmentWaitlist.typeId],
      references: [appointmentTypes.id],
    }),
  }),
);
