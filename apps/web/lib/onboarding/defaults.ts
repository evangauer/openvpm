import type { Database } from "@openpims/db/client";
import { and, eq, isNull } from "drizzle-orm";
import {
  appointmentTypes,
  rooms,
  services,
  clients,
  patients,
  appointments,
  users,
  soapNotes,
  vaccinationRecords,
  problemList,
  invoices,
  invoiceItems,
  communications,
  products,
} from "@openpims/db";

/**
 * Sensible defaults seeded for a brand-new practice so it's usable immediately
 * instead of landing in a blank dashboard. Data is plain/pure (easy to test);
 * `seedPractice` inserts it scoped to the new practice.
 */

export interface DefaultAppointmentType {
  name: string;
  durationMinutes: number;
  color: string;
  requiresDoctor: 0 | 1;
  defaultRoomType: "exam" | "surgery" | "treatment" | "boarding";
}

export const DEFAULT_APPOINTMENT_TYPES: DefaultAppointmentType[] = [
  { name: "Wellness Exam", durationMinutes: 30, color: "#0d9488", requiresDoctor: 1, defaultRoomType: "exam" },
  { name: "Sick Visit", durationMinutes: 30, color: "#dc2626", requiresDoctor: 1, defaultRoomType: "exam" },
  { name: "Vaccination", durationMinutes: 15, color: "#2563eb", requiresDoctor: 0, defaultRoomType: "exam" },
  { name: "Surgery", durationMinutes: 120, color: "#7c3aed", requiresDoctor: 1, defaultRoomType: "surgery" },
  { name: "Dental Cleaning", durationMinutes: 90, color: "#0891b2", requiresDoctor: 1, defaultRoomType: "surgery" },
  { name: "Recheck / Follow-up", durationMinutes: 15, color: "#65a30d", requiresDoctor: 1, defaultRoomType: "exam" },
];

export interface DefaultRoom {
  name: string;
  type: "exam" | "surgery" | "treatment" | "boarding";
}

export const DEFAULT_ROOMS: DefaultRoom[] = [
  { name: "Exam Room 1", type: "exam" },
  { name: "Exam Room 2", type: "exam" },
  { name: "Surgery Suite", type: "surgery" },
  { name: "Treatment Area", type: "treatment" },
];

export interface DefaultService {
  name: string;
  category: string;
  defaultPrice: string; // numeric column stores as string
  taxable: boolean;
}

export const DEFAULT_SERVICES: DefaultService[] = [
  { name: "Wellness Exam", category: "Exam", defaultPrice: "65.00", taxable: false },
  { name: "Sick / Problem Exam", category: "Exam", defaultPrice: "75.00", taxable: false },
  { name: "Recheck Exam", category: "Exam", defaultPrice: "45.00", taxable: false },
  { name: "Rabies Vaccine", category: "Vaccination", defaultPrice: "35.00", taxable: true },
  { name: "DHPP Vaccine", category: "Vaccination", defaultPrice: "40.00", taxable: true },
  { name: "Bordetella Vaccine", category: "Vaccination", defaultPrice: "38.00", taxable: true },
  { name: "FVRCP Vaccine", category: "Vaccination", defaultPrice: "40.00", taxable: true },
  { name: "Microchip", category: "Procedure", defaultPrice: "55.00", taxable: true },
  { name: "Nail Trim", category: "Procedure", defaultPrice: "20.00", taxable: true },
  { name: "Dental Cleaning", category: "Surgery", defaultPrice: "450.00", taxable: false },
  { name: "Spay / Neuter", category: "Surgery", defaultPrice: "350.00", taxable: false },
  { name: "Heartworm Test", category: "Diagnostics", defaultPrice: "45.00", taxable: false },
];

/**
 * Insert the default catalog for a freshly created practice. Idempotency is the
 * caller's responsibility (only call once, at registration).
 */
export async function seedPractice(
  db: Database,
  opts: { practiceId: string; locationId?: string | null }
): Promise<void> {
  await db.insert(appointmentTypes).values(
    DEFAULT_APPOINTMENT_TYPES.map((t) => ({
      practiceId: opts.practiceId,
      name: t.name,
      durationMinutes: t.durationMinutes,
      color: t.color,
      requiresDoctor: t.requiresDoctor,
      defaultRoomType: t.defaultRoomType,
    }))
  );

  await db.insert(rooms).values(
    DEFAULT_ROOMS.map((r) => ({
      practiceId: opts.practiceId,
      locationId: opts.locationId ?? null,
      name: r.name,
      type: r.type,
    }))
  );

  await db.insert(services).values(
    DEFAULT_SERVICES.map((s) => ({
      practiceId: opts.practiceId,
      name: s.name,
      category: s.category,
      defaultPrice: s.defaultPrice,
      taxable: s.taxable,
    }))
  );
}

export interface DemoDataIds {
  clientIds: string[];
  patientIds: string[];
  appointmentIds: string[];
  soapNoteIds: string[];
  vaccinationIds: string[];
  problemIds: string[];
  invoiceIds: string[];
  invoiceItemIds: string[];
  communicationIds: string[];
  productIds: string[];
}

/**
 * Seed a small set of demo clients/patients/appointments so a hosted trial
 * lands on a lively dashboard instead of empty states. The returned IDs are
 * stored on the practice so the onboarding wizard can clear them with one click.
 * Call only on hosted trials; non-fatal.
 */
export async function seedDemoData(
  db: Database,
  opts: { practiceId: string }
): Promise<DemoDataIds> {
  const insertedClients = await db
    .insert(clients)
    .values([
      { practiceId: opts.practiceId, firstName: "Jordan", lastName: "Avery", email: "jordan.avery@example.com", phone: "(555) 200-1001" },
      { practiceId: opts.practiceId, firstName: "Sam", lastName: "Rivera", email: "sam.rivera@example.com", phone: "(555) 200-1002" },
      { practiceId: opts.practiceId, firstName: "Taylor", lastName: "Brooks", email: "taylor.brooks@example.com", phone: "(555) 200-1003" },
    ])
    .returning({ id: clients.id });

  const insertedPatients = await db
    .insert(patients)
    .values([
      { practiceId: opts.practiceId, clientId: insertedClients[0]!.id, name: "Biscuit", species: "canine" as const, sex: "male_neutered" as const, breed: "Golden Retriever" },
      { practiceId: opts.practiceId, clientId: insertedClients[1]!.id, name: "Luna", species: "feline" as const, sex: "female_spayed" as const, breed: "Domestic Shorthair" },
      { practiceId: opts.practiceId, clientId: insertedClients[2]!.id, name: "Mango", species: "avian" as const, breed: "Sun Conure" },
    ])
    .returning({ id: patients.id });

  // Look up the catalog that seedPractice already created. These are optional:
  // if a lookup comes back empty we just leave that link null and keep going.
  const seededTypes = await db
    .select({ id: appointmentTypes.id, name: appointmentTypes.name })
    .from(appointmentTypes)
    .where(eq(appointmentTypes.practiceId, opts.practiceId));
  const seededRooms = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.practiceId, opts.practiceId));
  const seededServices = await db
    .select({
      id: services.id,
      name: services.name,
      defaultPrice: services.defaultPrice,
      taxable: services.taxable,
    })
    .from(services)
    .where(eq(services.practiceId, opts.practiceId));
  // The owner is the admin user for this practice.
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.practiceId, opts.practiceId),
        eq(users.role, "admin"),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  const typeByName = (name: string) =>
    seededTypes.find((t) => t.name === name)?.id ?? null;
  const wellnessTypeId = typeByName("Wellness Exam");
  const vaccineTypeId = typeByName("Vaccination");
  const sickTypeId = typeByName("Sick Visit");
  const recheckTypeId = typeByName("Recheck / Follow-up");
  const doctorId = owner?.id ?? null;
  const room1 = seededRooms[0]?.id ?? null;
  const room2 = seededRooms[1]?.id ?? room1;

  // Build a day of appointments inside business hours (clinic local time),
  // plus one in the future. Hours render 8-18 on the Schedule. The shape
  // follows how a real clinic day is staggered: morning wellness anchors, a same-day sick
  // visit, short vaccine/recheck slots, one doctor-less tech appointment
  // (nail trims and boosters run without a doctor, and it shows the Team
  // lane), and one deliberate mid-afternoon overlap so the side-by-side
  // rendering is visible. A mix of statuses makes the day look real.
  const todayAt = (hour: number, minute: number) => {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const mkAppt = (opts2: {
    clientIdx: number;
    patientIdx: number;
    start: Date;
    durationMin: number;
    status: "scheduled" | "confirmed" | "checked_in" | "in_exam";
    typeId: string | null;
    roomId: string | null;
    /** Omit for the owner; pass null for tech work with no doctor. */
    doctor?: string | null;
    notes?: string;
  }) => ({
    practiceId: opts.practiceId,
    clientId: insertedClients[opts2.clientIdx]!.id,
    patientId: insertedPatients[opts2.patientIdx]!.id,
    startTime: opts2.start,
    endTime: new Date(opts2.start.getTime() + opts2.durationMin * 60 * 1000),
    status: opts2.status,
    typeId: opts2.typeId,
    doctorId: opts2.doctor === undefined ? doctorId : opts2.doctor,
    roomId: opts2.roomId,
    notes: opts2.notes,
  });

  const futureStart = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const insertedAppts = await db
    .insert(appointments)
    .values([
      // Keep this first: the wellness SOAP note below links to it.
      mkAppt({
        clientIdx: 0,
        patientIdx: 0,
        start: todayAt(9, 0),
        durationMin: 30,
        status: "checked_in",
        typeId: wellnessTypeId,
        roomId: room1,
      }),
      mkAppt({
        clientIdx: 1,
        patientIdx: 1,
        start: todayAt(10, 0),
        durationMin: 30,
        status: "in_exam",
        typeId: sickTypeId,
        roomId: room2,
        notes: "Less active this week. Owner worried.",
      }),
      // Tech work runs without a doctor: this renders in the Team lane.
      mkAppt({
        clientIdx: 2,
        patientIdx: 2,
        start: todayAt(10, 0),
        durationMin: 15,
        status: "confirmed",
        typeId: vaccineTypeId,
        roomId: room1,
        doctor: null,
        notes: "Booster with the tech. Nail trim if time allows.",
      }),
      mkAppt({
        clientIdx: 1,
        patientIdx: 1,
        start: todayAt(11, 30),
        durationMin: 15,
        status: "confirmed",
        typeId: vaccineTypeId,
        roomId: room2,
      }),
      mkAppt({
        clientIdx: 2,
        patientIdx: 2,
        start: todayAt(14, 0),
        durationMin: 30,
        status: "scheduled",
        typeId: sickTypeId,
        roomId: room1,
      }),
      // Deliberate overlap with the 2:00: concurrent blocks render side by
      // side, never stacked.
      mkAppt({
        clientIdx: 0,
        patientIdx: 0,
        start: todayAt(14, 15),
        durationMin: 15,
        status: "scheduled",
        typeId: vaccineTypeId,
        roomId: room2,
      }),
      mkAppt({
        clientIdx: 1,
        patientIdx: 1,
        start: todayAt(15, 30),
        durationMin: 15,
        status: "scheduled",
        typeId: recheckTypeId,
        roomId: room1,
        notes: "Quick look at the teeth after starting dental care.",
      }),
      mkAppt({
        clientIdx: 0,
        patientIdx: 0,
        start: futureStart,
        durationMin: 30,
        status: "confirmed",
        typeId: wellnessTypeId,
        roomId: room1,
      }),
    ])
    .returning({ id: appointments.id });

  // Clinical records so the Records page tabs are not empty. authorId is required
  // on soap_notes, so only add them when we found the owner.
  let soapNoteIds: string[] = [];
  if (doctorId) {
    const insertedSoap = await db
      .insert(soapNotes)
      .values([
        {
          practiceId: opts.practiceId,
          patientId: insertedPatients[0]!.id,
          appointmentId: insertedAppts[0]?.id ?? null,
          authorId: doctorId,
          subjective: "Owner reports Biscuit is bright and eating well. Here for a yearly wellness check.",
          objective: "Weight 31 kg. Temp normal. Heart and lungs sound clear. Coat looks healthy.",
          assessment: "Healthy adult dog. No problems found today.",
          plan: "Keep up the current diet. Give the Rabies booster. Recheck in one year.",
        },
        {
          practiceId: opts.practiceId,
          patientId: insertedPatients[1]!.id,
          appointmentId: null,
          authorId: doctorId,
          subjective: "Luna is a bit less active this week per owner.",
          objective: "Weight 4.2 kg. Mild tartar on back teeth. Rest of exam is normal.",
          assessment: "Early dental tartar. Otherwise healthy cat.",
          plan: "Start at-home dental care. Plan a dental cleaning in the next few months.",
        },
      ])
      .returning({ id: soapNotes.id });
    soapNoteIds = insertedSoap.map((s) => s.id);
  }

  // A couple of vaccine records (recent Rabies, recent DHPP) with next-due dates.
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };
  const insertedVax = await db
    .insert(vaccinationRecords)
    .values([
      {
        practiceId: opts.practiceId,
        patientId: insertedPatients[0]!.id,
        vaccineName: "Rabies",
        manufacturer: "Sample Labs",
        lotNumber: "RB-1042",
        administeredBy: doctorId,
        administeredAt: daysFromNow(-30),
        nextDueDate: ymd(daysFromNow(335)),
      },
      {
        practiceId: opts.practiceId,
        patientId: insertedPatients[0]!.id,
        vaccineName: "DHPP",
        manufacturer: "Sample Labs",
        lotNumber: "DH-2087",
        administeredBy: doctorId,
        administeredAt: daysFromNow(-30),
        nextDueDate: ymd(daysFromNow(-5)),
      },
    ])
    .returning({ id: vaccinationRecords.id });

  // A tiny medication shelf makes the prescription and inventory workflows
  // usable on a first visit instead of presenting an empty product selector.
  const insertedProducts = await db
    .insert(products)
    .values([
      {
        practiceId: opts.practiceId,
        name: "Carprofen 75 mg tablets",
        sku: "SAMPLE-CARP-75",
        category: "Medication",
        unitPrice: "1.25",
        costPrice: "0.52",
        stockQuantity: 100,
        reorderPoint: 20,
      },
      {
        practiceId: opts.practiceId,
        name: "Amoxicillin 250 mg capsules",
        sku: "SAMPLE-AMOX-250",
        category: "Medication",
        unitPrice: "0.85",
        costPrice: "0.31",
        stockQuantity: 60,
        reorderPoint: 15,
      },
    ])
    .returning({ id: products.id });

  // One problem-list entry so that tab shows content too.
  const insertedProblems = await db
    .insert(problemList)
    .values([
      {
        practiceId: opts.practiceId,
        patientId: insertedPatients[1]!.id,
        description: "Mild dental tartar",
        status: "active",
        onsetDate: ymd(daysFromNow(-14)),
      },
    ])
    .returning({ id: problemList.id });

  // Two invoices with line items from the seeded services: one paid, one sent.
  const serviceByName = (name: string) =>
    seededServices.find((s) => s.name === name) ?? null;
  const taxRate = 0.07;
  const money = (n: number) => n.toFixed(2);

  const invoiceIds: string[] = [];
  const invoiceItemIds: string[] = [];

  const buildInvoice = async (cfg: {
    clientIdx: number;
    patientIdx: number;
    status: "paid" | "sent";
    serviceNames: string[];
  }) => {
    // Resolve line items from the catalog; fall back to a simple line if a name
    // is missing so we never end up with a blank invoice.
    const lines = cfg.serviceNames
      .map((name) => serviceByName(name))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const safeLines =
      lines.length > 0
        ? lines
        : [{ id: null, name: "Office Visit", defaultPrice: "65.00", taxable: false }];

    let subtotal = 0;
    let tax = 0;
    for (const line of safeLines) {
      const price = Number(line.defaultPrice) || 0;
      subtotal += price;
      if (line.taxable) tax += price * taxRate;
    }
    const total = subtotal + tax;

    const [inv] = await db
      .insert(invoices)
      .values({
        practiceId: opts.practiceId,
        clientId: insertedClients[cfg.clientIdx]!.id,
        patientId: insertedPatients[cfg.patientIdx]!.id,
        status: cfg.status,
        subtotal: money(subtotal),
        tax: money(tax),
        total: money(total),
        paidAmount: cfg.status === "paid" ? money(total) : "0",
        dueDate: ymd(daysFromNow(cfg.status === "paid" ? -3 : 14)),
      })
      .returning({ id: invoices.id });
    invoiceIds.push(inv!.id);

    const itemRows = safeLines.map((line) => ({
      invoiceId: inv!.id,
      description: line.name,
      quantity: 1,
      unitPrice: money(Number(line.defaultPrice) || 0),
      total: money(Number(line.defaultPrice) || 0),
      itemType: "service" as const,
      itemId: line.id,
    }));
    const insertedItems = await db
      .insert(invoiceItems)
      .values(itemRows)
      .returning({ id: invoiceItems.id });
    invoiceItemIds.push(...insertedItems.map((i) => i.id));
  };

  await buildInvoice({
    clientIdx: 0,
    patientIdx: 0,
    status: "paid",
    serviceNames: ["Wellness Exam", "Rabies Vaccine", "DHPP Vaccine"],
  });
  await buildInvoice({
    clientIdx: 1,
    patientIdx: 1,
    status: "sent",
    serviceNames: ["Wellness Exam", "Nail Trim"],
  });

  // A few inbound messages so the Inbox has real conversations to show in the
  // walkthrough. Inbound + status not "read" + no readAt renders as unread.
  const insertedComms = await db
    .insert(communications)
    .values([
      {
        practiceId: opts.practiceId,
        clientId: insertedClients[0]!.id,
        channel: "sms" as const,
        direction: "inbound" as const,
        content:
          "Hi! Is Biscuit due for anything at his visit tomorrow? Want to make sure we do it all in one trip.",
        status: "delivered" as const,
      },
      {
        practiceId: opts.practiceId,
        clientId: insertedClients[1]!.id,
        channel: "email" as const,
        direction: "inbound" as const,
        subject: "Luna's recent invoice",
        content:
          "Thanks for seeing Luna. Quick question about the invoice you sent, can I pay online?",
        status: "delivered" as const,
      },
      {
        practiceId: opts.practiceId,
        clientId: insertedClients[2]!.id,
        channel: "sms" as const,
        direction: "inbound" as const,
        content: "Can I get a copy of Mango's records for our new groomer?",
        status: "delivered" as const,
      },
    ])
    .returning({ id: communications.id });

  return {
    clientIds: insertedClients.map((c) => c.id),
    patientIds: insertedPatients.map((p) => p.id),
    appointmentIds: insertedAppts.map((a) => a.id),
    soapNoteIds,
    vaccinationIds: insertedVax.map((v) => v.id),
    problemIds: insertedProblems.map((p) => p.id),
    invoiceIds,
    invoiceItemIds,
    communicationIds: insertedComms.map((c) => c.id),
    productIds: insertedProducts.map((product) => product.id),
  };
}
