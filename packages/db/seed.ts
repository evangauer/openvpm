import { config } from "dotenv";
config({ path: "../../.env" });
import crypto from "crypto";
import { db } from "./client";
import {
  practices,
  locations,
  users,
  clients,
  patients,
  patientWeights,
  patientAllergies,
  appointmentTypes,
  rooms,
  appointments,
  soapNotes,
  vaccinationRecords,
  prescriptions,
  labResults,
  labResultEvents,
  clinicalRecordCorrections,
  labResultReplacements,
  procedures,
  invoices,
  invoiceItems,
  products,
  services,
  payments,
  communications,
  auditLog,
  controlledSubstanceLog,
  treatmentTemplates,
  treatmentTemplateItems,
} from "./schema/index";

// Pre-hashed bcrypt value for "password123"
const PASSWORD_HASH =
  "$2a$10$1Ui3ssO.fTXmUiyu4B7n0.EWb/M9fGHlZ5mjCXaq.Xqf1OdXwLs/K";

// ---------------------------------------------------------------------------
// Helper: date math
// ---------------------------------------------------------------------------
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function setTime(d: Date, hours: number, minutes: number): Date {
  const copy = new Date(d);
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function seed() {
  console.log("Seeding database...\n");

  // =========================================================================
  // 1. Practice
  // =========================================================================
  const [practice] = await db
    .insert(practices)
    .values({
      name: "Neighborhood Veterinary",
      address: "320 Elm Street, Suite 101, Maplewood, NJ 07040",
      phone: "(555) 867-5309",
      email: "hello@neighborhoodvet.example.com",
      website: "https://neighborhoodvet.example.com",
      timezone: "America/New_York",
      subscriptionTier: "cloud",
      // The demo practice is a fully set-up clinic; the first-run wizard
      // must not greet it like a new signup.
      settings: { onboardingCompletedAt: new Date().toISOString() },
    })
    .returning();
  console.log(`Practice: ${practice!.name} (${practice!.id})`);
  const practiceId = practice!.id;

  // =========================================================================
  // 2. Location
  // =========================================================================
  const [location] = await db
    .insert(locations)
    .values({
      practiceId,
      name: "Main Clinic",
      address: "320 Elm Street, Suite 101, Maplewood, NJ 07040",
      phone: "(555) 867-5309",
      isPrimary: true,
    })
    .returning();
  console.log(`Location: ${location!.name}`);
  const locationId = location!.id;

  // =========================================================================
  // 3. Users (7 staff)
  // =========================================================================
  const usersData = [
    {
      email: "admin@neighborhoodvet.example.com",
      name: "Practice Admin",
      role: "admin" as const,
      licenseNumber: null,
      phone: "(555) 867-5309 x100",
    },
    {
      email: "sarah.chen@neighborhoodvet.example.com",
      name: "Dr. Sarah Chen",
      role: "veterinarian" as const,
      licenseNumber: "VET-NJ-28491",
      phone: "(555) 867-5309 x101",
    },
    {
      email: "marcus.rivera@neighborhoodvet.example.com",
      name: "Dr. Marcus Rivera",
      role: "veterinarian" as const,
      licenseNumber: "VET-NJ-31057",
      phone: "(555) 867-5309 x102",
    },
    {
      email: "emily.walsh@neighborhoodvet.example.com",
      name: "Dr. Emily Walsh",
      role: "veterinarian" as const,
      licenseNumber: "VET-NJ-34219",
      phone: "(555) 867-5309 x103",
    },
    {
      email: "jamie.torres@neighborhoodvet.example.com",
      name: "Jamie Torres",
      role: "technician" as const,
      licenseNumber: "LVT-NJ-7823",
      phone: "(555) 867-5309 x201",
    },
    {
      email: "alex.kim@neighborhoodvet.example.com",
      name: "Alex Kim",
      role: "technician" as const,
      licenseNumber: "LVT-NJ-8104",
      phone: "(555) 867-5309 x202",
    },
    {
      email: "morgan.bailey@neighborhoodvet.example.com",
      name: "Morgan Bailey",
      role: "front_desk" as const,
      licenseNumber: null,
      phone: "(555) 867-5309 x301",
    },
    {
      email: "casey.reed@neighborhoodvet.example.com",
      name: "Casey Reed",
      role: "front_desk" as const,
      licenseNumber: null,
      phone: "(555) 867-5309 x302",
    },
  ];

  const insertedUsers = await db
    .insert(users)
    .values(
      usersData.map((u) => ({
        ...u,
        isVeterinarian: u.role === "veterinarian",
        passwordHash: PASSWORD_HASH,
        practiceId,
        locationId,
      }))
    )
    .returning();
  console.log(`Users: ${insertedUsers.length} created`);

  const vets = insertedUsers.filter((u) => u.role === "veterinarian");
  const techs = insertedUsers.filter((u) => u.role === "technician");

  // =========================================================================
  // 4. Clients (25)
  // =========================================================================
  const clientsData = [
    { firstName: "James", lastName: "Patterson", address: "12 Lakehill Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1001", email: "james.patterson@example.com" },
    { firstName: "Maria", lastName: "Gonzalez", address: "45 Kingsley Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1002", email: "maria.gonzalez@example.com" },
    { firstName: "Robert", lastName: "Thompson", address: "78 Charlton Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1003", email: "robert.thompson@example.com" },
    { firstName: "Jennifer", lastName: "O'Brien", address: "234 Lake Ave", city: "South Orange", state: "NJ", zip: "07079", phone: "(555) 010-1004", email: "jennifer.obrien@example.com" },
    { firstName: "Michael", lastName: "Rossi", address: "56 Goode St", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1005", email: "michael.rossi@example.com" },
    { firstName: "Susan", lastName: "Park", address: "89 Lakehill Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1006", email: "susan.park@example.com" },
    { firstName: "David", lastName: "Murphy", address: "123 Route 50", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1007", email: "david.murphy@example.com" },
    { firstName: "Linda", lastName: "Hoffman", address: "456 Saratoga Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1008", email: "linda.hoffman@example.com" },
    { firstName: "William", lastName: "Anderson", address: "22 High St", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1009", email: "william.anderson@example.com" },
    { firstName: "Patricia", lastName: "Lee", address: "67 Outlet Rd", city: "West Orange", state: "NJ", zip: "07052", phone: "(555) 010-1010", email: "patricia.lee@example.com" },
    { firstName: "Richard", lastName: "Nguyen", address: "301 Broadway", city: "South Orange", state: "NJ", zip: "07079", phone: "(555) 010-1011", email: "richard.nguyen@example.com" },
    { firstName: "Barbara", lastName: "Schmidt", address: "15 Lakehill Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1012", email: "barbara.schmidt@example.com" },
    { firstName: "Thomas", lastName: "Wilson", address: "88 Route 50", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1013", email: "thomas.wilson@example.com" },
    { firstName: "Elizabeth", lastName: "Martin", address: "42 Church Ave", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1014", email: "elizabeth.martin@example.com" },
    { firstName: "Charles", lastName: "Taylor", address: "19 Brookline Rd", city: "West Orange", state: "NJ", zip: "07052", phone: "(555) 010-1015", email: "charles.taylor@example.com" },
    { firstName: "Karen", lastName: "Davis", address: "200 Union Ave", city: "South Orange", state: "NJ", zip: "07079", phone: "(555) 010-1016", email: "karen.davis@example.com" },
    { firstName: "Daniel", lastName: "Clark", address: "77 Charlton Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1017", email: "daniel.clark@example.com" },
    { firstName: "Nancy", lastName: "Lewis", address: "33 Middleline Rd", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1018", email: "nancy.lewis@example.com" },
    { firstName: "Joseph", lastName: "Walker", address: "55 Lake Rd", city: "West Orange", state: "NJ", zip: "07052", phone: "(555) 010-1019", email: "joseph.walker@example.com" },
    { firstName: "Margaret", lastName: "Young", address: "99 Kingsley Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1020", email: "margaret.young@example.com" },
    { firstName: "Steven", lastName: "Hall", address: "144 Route 9P", city: "South Orange", state: "NJ", zip: "07079", phone: "(555) 010-1021", email: "steven.hall@example.com" },
    { firstName: "Dorothy", lastName: "Allen", address: "28 Goode St", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1022", email: "dorothy.allen@example.com" },
    { firstName: "Andrew", lastName: "King", address: "61 Malta Ave", city: "Millburn", state: "NJ", zip: "07041", phone: "(555) 010-1023", email: "andrew.king@example.com" },
    { firstName: "Sandra", lastName: "Wright", address: "73 Outlet Rd", city: "West Orange", state: "NJ", zip: "07052", phone: "(555) 010-1024", email: "sandra.wright@example.com" },
    { firstName: "Kevin", lastName: "Lopez", address: "180 Saratoga Rd", city: "Maplewood", state: "NJ", zip: "07040", phone: "(555) 010-1025", email: "kevin.lopez@example.com" },
  ];

  const insertedClients = await db
    .insert(clients)
    .values(
      clientsData.map((c) => ({
        ...c,
        practiceId,
        preferredContactMethod: "phone" as const,
        accessToken: null,
      })),
    )
    .returning();
  console.log(`Clients: ${insertedClients.length} created`);

  // =========================================================================
  // 5. Patients (40) — dogs ~20, cats ~15, rabbits 2, birds 2, reptile 1
  // =========================================================================
  const patientsData: {
    clientIdx: number;
    name: string;
    species: "canine" | "feline" | "avian" | "rabbit" | "reptile";
    breed: string;
    sex: "male" | "female" | "male_neutered" | "female_spayed";
    dob: string;
    color: string;
    weightKg: string;
  }[] = [
    // Dogs (20)
    { clientIdx: 0, name: "Max", species: "canine", breed: "Golden Retriever", sex: "male_neutered", dob: "2020-03-15", color: "Golden", weightKg: "31.8" },
    { clientIdx: 1, name: "Luna", species: "canine", breed: "German Shepherd", sex: "female_spayed", dob: "2019-08-22", color: "Black and Tan", weightKg: "28.6" },
    { clientIdx: 2, name: "Charlie", species: "canine", breed: "Labrador Retriever", sex: "male_neutered", dob: "2021-01-10", color: "Chocolate", weightKg: "33.2" },
    { clientIdx: 3, name: "Bella", species: "canine", breed: "French Bulldog", sex: "female_spayed", dob: "2022-05-18", color: "Fawn", weightKg: "11.3" },
    { clientIdx: 4, name: "Cooper", species: "canine", breed: "Beagle", sex: "male_neutered", dob: "2020-11-03", color: "Tricolor", weightKg: "10.9" },
    { clientIdx: 5, name: "Daisy", species: "canine", breed: "Poodle", sex: "female_spayed", dob: "2018-06-25", color: "White", weightKg: "6.8" },
    { clientIdx: 6, name: "Rocky", species: "canine", breed: "Rottweiler", sex: "male", dob: "2021-09-14", color: "Black and Rust", weightKg: "45.4" },
    { clientIdx: 7, name: "Sadie", species: "canine", breed: "Cavalier King Charles Spaniel", sex: "female_spayed", dob: "2022-02-28", color: "Blenheim", weightKg: "7.3" },
    { clientIdx: 8, name: "Tucker", species: "canine", breed: "Australian Shepherd", sex: "male_neutered", dob: "2020-07-12", color: "Blue Merle", weightKg: "25.0" },
    { clientIdx: 9, name: "Molly", species: "canine", breed: "Boxer", sex: "female_spayed", dob: "2019-04-05", color: "Brindle", weightKg: "27.2" },
    { clientIdx: 10, name: "Bear", species: "canine", breed: "Bernese Mountain Dog", sex: "male_neutered", dob: "2021-12-01", color: "Tricolor", weightKg: "43.5" },
    { clientIdx: 11, name: "Rosie", species: "canine", breed: "Cocker Spaniel", sex: "female_spayed", dob: "2020-10-17", color: "Buff", weightKg: "12.7" },
    { clientIdx: 12, name: "Duke", species: "canine", breed: "Great Dane", sex: "male", dob: "2022-08-09", color: "Blue", weightKg: "54.4" },
    { clientIdx: 13, name: "Penny", species: "canine", breed: "Shih Tzu", sex: "female_spayed", dob: "2019-01-20", color: "Gold and White", weightKg: "5.9" },
    { clientIdx: 14, name: "Finn", species: "canine", breed: "Border Collie", sex: "male_neutered", dob: "2021-04-30", color: "Black and White", weightKg: "18.6" },
    { clientIdx: 15, name: "Zoe", species: "canine", breed: "Dachshund", sex: "female_spayed", dob: "2020-02-14", color: "Red", weightKg: "5.4" },
    { clientIdx: 16, name: "Gus", species: "canine", breed: "Miniature Schnauzer", sex: "male_neutered", dob: "2022-11-25", color: "Salt and Pepper", weightKg: "7.7" },
    { clientIdx: 0, name: "Buddy", species: "canine", breed: "Mixed Breed", sex: "male_neutered", dob: "2018-09-08", color: "Tan", weightKg: "22.7" },
    { clientIdx: 3, name: "Chloe", species: "canine", breed: "Yorkshire Terrier", sex: "female", dob: "2023-03-12", color: "Blue and Tan", weightKg: "3.2" },
    { clientIdx: 7, name: "Winston", species: "canine", breed: "English Bulldog", sex: "male_neutered", dob: "2021-06-15", color: "White and Red", weightKg: "22.0" },
    // Cats (15)
    { clientIdx: 1, name: "Whiskers", species: "feline", breed: "Domestic Shorthair", sex: "male_neutered", dob: "2019-05-10", color: "Orange Tabby", weightKg: "5.0" },
    { clientIdx: 4, name: "Mittens", species: "feline", breed: "Siamese", sex: "female_spayed", dob: "2020-12-05", color: "Seal Point", weightKg: "3.9" },
    { clientIdx: 6, name: "Shadow", species: "feline", breed: "Domestic Longhair", sex: "male_neutered", dob: "2018-03-18", color: "Black", weightKg: "5.9" },
    { clientIdx: 9, name: "Tigger", species: "feline", breed: "Maine Coon", sex: "male", dob: "2021-07-22", color: "Brown Tabby", weightKg: "7.3" },
    { clientIdx: 11, name: "Cleo", species: "feline", breed: "Russian Blue", sex: "female_spayed", dob: "2020-09-30", color: "Blue", weightKg: "4.1" },
    { clientIdx: 14, name: "Oliver", species: "feline", breed: "British Shorthair", sex: "male_neutered", dob: "2022-01-14", color: "Blue", weightKg: "5.4" },
    { clientIdx: 17, name: "Nala", species: "feline", breed: "Abyssinian", sex: "female_spayed", dob: "2021-11-08", color: "Ruddy", weightKg: "3.6" },
    { clientIdx: 18, name: "Simba", species: "feline", breed: "Persian", sex: "male_neutered", dob: "2019-06-17", color: "White", weightKg: "4.5" },
    { clientIdx: 19, name: "Lily", species: "feline", breed: "Ragdoll", sex: "female_spayed", dob: "2020-04-25", color: "Blue Bicolor", weightKg: "4.8" },
    { clientIdx: 20, name: "Jasper", species: "feline", breed: "Bengal", sex: "male_neutered", dob: "2022-06-03", color: "Brown Spotted", weightKg: "5.0" },
    { clientIdx: 21, name: "Mochi", species: "feline", breed: "Scottish Fold", sex: "female_spayed", dob: "2021-02-20", color: "Gray", weightKg: "3.8" },
    { clientIdx: 22, name: "Felix", species: "feline", breed: "Domestic Shorthair", sex: "male_neutered", dob: "2018-10-11", color: "Tuxedo", weightKg: "5.7" },
    { clientIdx: 23, name: "Luna", species: "feline", breed: "Sphynx", sex: "female", dob: "2023-01-05", color: "Pink", weightKg: "3.4" },
    { clientIdx: 24, name: "Oreo", species: "feline", breed: "Domestic Shorthair", sex: "male_neutered", dob: "2020-08-15", color: "Black and White", weightKg: "4.9" },
    { clientIdx: 5, name: "Callie", species: "feline", breed: "Calico", sex: "female_spayed", dob: "2019-12-01", color: "Calico", weightKg: "4.0" },
    // Rabbits (2)
    { clientIdx: 10, name: "Thumper", species: "rabbit", breed: "Holland Lop", sex: "male_neutered", dob: "2022-04-10", color: "Tort", weightKg: "1.8" },
    { clientIdx: 16, name: "Clover", species: "rabbit", breed: "Mini Rex", sex: "female_spayed", dob: "2023-02-14", color: "Castor", weightKg: "1.5" },
    // Birds (2)
    { clientIdx: 13, name: "Kiwi", species: "avian", breed: "Cockatiel", sex: "male", dob: "2021-08-05", color: "Gray and Yellow", weightKg: "0.09" },
    { clientIdx: 19, name: "Sunny", species: "avian", breed: "Sun Conure", sex: "female", dob: "2022-03-20", color: "Yellow and Orange", weightKg: "0.11" },
    // Reptile (1)
    { clientIdx: 20, name: "Rex", species: "reptile", breed: "Bearded Dragon", sex: "male", dob: "2021-05-15", color: "Tan", weightKg: "0.45" },
  ];

  const insertedPatients = await db
    .insert(patients)
    .values(
      patientsData.map((p) => ({
        practiceId,
        clientId: insertedClients[p.clientIdx]!.id,
        name: p.name,
        species: p.species,
        breed: p.breed,
        sex: p.sex,
        dob: p.dob,
        color: p.color,
        status: "active" as const,
      }))
    )
    .returning();
  console.log(`Patients: ${insertedPatients.length} created`);

  // Patient weights
  await db.insert(patientWeights).values(
    patientsData.map((p, i) => ({
      patientId: insertedPatients[i]!.id,
      weightKg: p.weightKg,
      recordedAt: daysAgo(Math.floor(Math.random() * 30)),
      recordedBy: pickRandom(techs).id,
    }))
  );
  console.log("Patient weights recorded");

  // Patient allergies (a few)
  await db.insert(patientAllergies).values([
    { patientId: insertedPatients[0]!.id, allergen: "Penicillin", reaction: "Hives, facial swelling", severity: "severe" as const, notedBy: vets[0]!.id },
    { patientId: insertedPatients[3]!.id, allergen: "Chicken", reaction: "GI upset, itching", severity: "moderate" as const, notedBy: vets[1]!.id },
    { patientId: insertedPatients[9]!.id, allergen: "Bee Stings", reaction: "Anaphylaxis", severity: "severe" as const, notedBy: vets[2]!.id },
    { patientId: insertedPatients[21]!.id, allergen: "Latex", reaction: "Contact dermatitis", severity: "mild" as const, notedBy: vets[0]!.id },
  ]);
  console.log("Patient allergies recorded");

  // =========================================================================
  // 6. Appointment Types
  // =========================================================================
  const apptTypesData = [
    { name: "Wellness Exam", durationMinutes: 30, color: "#0d9488", requiresDoctor: 1, defaultRoomType: "exam" as const },
    { name: "Sick Visit", durationMinutes: 30, color: "#dc2626", requiresDoctor: 1, defaultRoomType: "exam" as const },
    { name: "Vaccination", durationMinutes: 15, color: "#2563eb", requiresDoctor: 1, defaultRoomType: "exam" as const },
    { name: "Surgery", durationMinutes: 60, color: "#7c3aed", requiresDoctor: 1, defaultRoomType: "surgery" as const },
    { name: "Dental", durationMinutes: 45, color: "#ea580c", requiresDoctor: 1, defaultRoomType: "exam" as const },
    { name: "Follow-up", durationMinutes: 15, color: "#16a34a", requiresDoctor: 1, defaultRoomType: "exam" as const },
  ];

  const insertedApptTypes = await db
    .insert(appointmentTypes)
    .values(apptTypesData.map((t) => ({ ...t, practiceId })))
    .returning();
  console.log(`Appointment types: ${insertedApptTypes.length} created`);

  // =========================================================================
  // 7. Exam Rooms (3)
  // =========================================================================
  const insertedRooms = await db
    .insert(rooms)
    .values([
      { practiceId, locationId, name: "Exam Room 1", type: "exam" as const },
      { practiceId, locationId, name: "Exam Room 2", type: "exam" as const },
      { practiceId, locationId, name: "Exam Room 3", type: "exam" as const },
    ])
    .returning();
  console.log(`Rooms: ${insertedRooms.length} created`);

  // =========================================================================
  // 8. Appointments — 2 weeks (past week + current week)
  //    ~5-8 per day per vet, Mon-Fri, 9am-5pm
  // =========================================================================
  const appointmentValues: {
    practiceId: string;
    locationId: string;
    startTime: Date;
    endTime: Date;
    typeId: string;
    patientId: string;
    clientId: string;
    doctorId: string;
    roomId: string;
    status: "scheduled" | "confirmed" | "checked_in" | "in_exam" | "checked_out" | "no_show" | "cancelled";
    notes: string | null;
  }[] = [];

  const today = new Date();
  const currentDow = today.getDay(); // 0=Sun

  // Generate 10 weekdays: 5 from last week (Mon-Fri) + 5 from this week
  const weekdays: Date[] = [];
  // Last Monday = today - currentDow - 6 (if currentDow is e.g. 3/Wed, last Mon = -8)
  // More robust: last week Mon = this week Mon - 7
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - (currentDow === 0 ? 6 : currentDow - 1));
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  for (let w = 0; w < 2; w++) {
    const weekStart = w === 0 ? lastMonday : thisMonday;
    for (let d = 0; d < 5; d++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + d);
      weekdays.push(day);
    }
  }

  const timeSlots = [
    { hour: 9, min: 0 },
    { hour: 9, min: 30 },
    { hour: 10, min: 0 },
    { hour: 10, min: 30 },
    { hour: 11, min: 0 },
    { hour: 11, min: 30 },
    { hour: 13, min: 0 },
    { hour: 13, min: 30 },
    { hour: 14, min: 0 },
    { hour: 14, min: 30 },
    { hour: 15, min: 0 },
    { hour: 15, min: 30 },
    { hour: 16, min: 0 },
    { hour: 16, min: 30 },
  ];

  const pastStatuses: ("checked_out" | "no_show" | "cancelled")[] = [
    "checked_out", "checked_out", "checked_out", "checked_out",
    "checked_out", "checked_out", "checked_out", "checked_out",
    "no_show", "cancelled",
  ];

  const futureStatuses: ("scheduled" | "confirmed")[] = ["scheduled", "confirmed", "confirmed"];

  for (const day of weekdays) {
    const isPast = day < today && day.toDateString() !== today.toDateString();
    const isToday = day.toDateString() === today.toDateString();

    for (const vet of vets) {
      // 5-8 appointments per day per vet
      const numAppts = 5 + Math.floor(Math.random() * 4);
      const daySlots = pickN(timeSlots, numAppts);
      daySlots.sort((a, b) => a.hour * 60 + a.min - (b.hour * 60 + b.min));

      for (const slot of daySlots) {
        const apptType = pickRandom(insertedApptTypes);
        const patient = pickRandom(insertedPatients);
        // The appointment's client MUST be the patient's actual owner. The
        // schedule/dashboard patient-name join requires
        // patient.clientId === appointment.clientId, so a mismatched client
        // makes the name resolve to null and render as "Unknown Patient".
        // Map by the patient's own clientIdx, not its position in the array.
        const patientIdx = insertedPatients.indexOf(patient);
        const clientForPatient = insertedClients[patientsData[patientIdx]!.clientIdx];
        const startTime = setTime(day, slot.hour, slot.min);
        const endTime = addMinutes(startTime, apptType.durationMinutes);

        let status: typeof appointmentValues[0]["status"];
        if (isPast) {
          status = pickRandom(pastStatuses);
        } else if (isToday) {
          const nowHour = today.getHours();
          if (slot.hour < nowHour) {
            status = pickRandom(["checked_out", "checked_out", "checked_out", "no_show"] as const);
          } else if (slot.hour === nowHour) {
            status = pickRandom(["in_exam", "checked_in"] as const);
          } else {
            status = pickRandom(["scheduled", "confirmed", "confirmed"] as const);
          }
        } else {
          status = pickRandom(futureStatuses);
        }

        appointmentValues.push({
          practiceId,
          locationId,
          startTime,
          endTime,
          typeId: apptType.id,
          patientId: patient.id,
          clientId: clientForPatient
            ? clientForPatient.id
            : insertedClients[0]!.id,
          doctorId: vet.id,
          roomId: pickRandom(insertedRooms).id,
          status,
          notes: crypto.randomInt(10) > 6 ? "Owner reports no concerns" : null,
        });
      }
    }
  }

  const insertedAppointments = await db
    .insert(appointments)
    .values(appointmentValues)
    .returning();
  console.log(`Appointments: ${insertedAppointments.length} created`);

  // =========================================================================
  // 9. SOAP Notes for past checked_out appointments (sample)
  // =========================================================================
  const pastCheckedOut = insertedAppointments.filter(
    (a) => a.status === "checked_out"
  );

  const soapTemplates = [
    {
      subjective: "Owner reports patient has been eating and drinking normally. No vomiting or diarrhea. Activity level normal. Up to date on flea/tick prevention.",
      objective: "T: 101.2F, HR: 80bpm, RR: 20. BCS: 5/9. Bright, alert, responsive. Coat in good condition. No abnormal findings on physical exam. Teeth show mild tartar buildup on molars.",
      assessment: "Healthy patient, routine wellness exam. Mild dental tartar noted - recommend dental cleaning within the next 6 months.",
      plan: "Continue current diet and exercise. Schedule dental cleaning. Update vaccinations per protocol. Recheck in 1 year or as needed.",
    },
    {
      subjective: "Owner reports decreased appetite for 2 days. Patient seems lethargic. No vomiting but soft stools noted. Drinking water normally.",
      objective: "T: 102.8F, HR: 110bpm, RR: 28. BCS: 4/9. Mild dehydration noted. Abdomen slightly tense on palpation. No masses felt. Mild discomfort in cranial abdomen.",
      assessment: "Suspected gastroenteritis. DDx includes dietary indiscretion, pancreatitis, foreign body. Recommend bloodwork and monitoring.",
      plan: "CBC/Chem panel submitted. Bland diet (boiled chicken and rice) for 3-5 days. Cerenia 1mg/kg SQ administered. Recheck in 48 hours if not improving. ER if vomiting begins or lethargy worsens.",
    },
    {
      subjective: "Annual vaccination visit. Owner has no concerns. Patient on monthly Heartgard and NexGard.",
      objective: "T: 100.8F, HR: 90bpm, RR: 18. BCS: 6/9. Slightly overweight. All systems within normal limits on exam. Heart and lungs auscultate normally.",
      assessment: "Healthy patient, slightly overweight. Vaccines updated today.",
      plan: "Administered DHPP and Rabies vaccines. Recommend reducing daily food by 10% and increasing exercise. Weight recheck in 3 months. Next annual due in 1 year.",
    },
    {
      subjective: "Patient presented for limping on right forelimb, noticed by owner after playing at park yesterday. No known trauma. Not improving overnight.",
      objective: "T: 101.5F, HR: 95bpm, RR: 22. Grade 2/5 right forelimb lameness. Pain on flexion of right elbow. Mild soft tissue swelling noted over lateral elbow. No crepitus. Good range of motion in shoulder and carpus.",
      assessment: "Right forelimb lameness, likely soft tissue injury to elbow region. Radiographs unremarkable - no fracture or OCD lesion identified.",
      plan: "Rimadyl 2mg/kg BID for 7 days with food. Strict rest for 2 weeks - leash walks only. Cold compress 10 min TID for first 3 days. Recheck in 2 weeks. If not improving, consider referral for advanced imaging.",
    },
    {
      subjective: "Routine dental cleaning under anesthesia. Pre-anesthetic bloodwork performed last week and was within normal limits. NPO since 10pm last night.",
      objective: "Pre-anesthetic vitals: T: 101.0F, HR: 88bpm, RR: 16. ASA Class I. Grade 2 dental disease with moderate tartar on premolars and molars. Mild gingivitis noted. Full mouth radiographs taken.",
      assessment: "Dental disease grade 2. Moderate tartar accumulation. No tooth root abscess on radiographs. All teeth intact and viable.",
      plan: "Full dental prophylaxis performed under general anesthesia (propofol induction, isoflurane maintenance). All tartar removed. Teeth polished. Fluoride treatment applied. Recovery uneventful. Discharge this evening with soft food for 3 days.",
    },
  ];

  const soapNotesCount = Math.min(pastCheckedOut.length, 40);
  const soapNotesToCreate = pastCheckedOut.slice(0, soapNotesCount);
  await db.insert(soapNotes).values(
    soapNotesToCreate.map((appt) => {
      const template = pickRandom(soapTemplates);
      const author = insertedUsers.find((user) => user.id === appt.doctorId)!;
      const finalizedAt = new Date();
      return {
        practiceId,
        patientId: appt.patientId!,
        appointmentId: appt.id,
        authorId: author.id,
        authorName: author.name,
        status: "finalized" as const,
        revision: 1,
        finalizedAt,
        finalizedBy: author.id,
        finalizerName: author.name,
        subjective: template.subjective,
        objective: template.objective,
        assessment: template.assessment,
        plan: template.plan,
      };
    })
  );
  console.log(`SOAP notes: ${soapNotesCount} created`);

  // =========================================================================
  // 10. Vaccination Records
  // =========================================================================
  const vaccineData = [
    { name: "DHPP (Distemper/Hepatitis/Parainfluenza/Parvovirus)", manufacturer: "Zoetis", nextDueMonths: 12 },
    { name: "Rabies (3-year)", manufacturer: "Boehringer Ingelheim", nextDueMonths: 36 },
    { name: "Bordetella", manufacturer: "Zoetis", nextDueMonths: 12 },
    { name: "Lyme (Borrelia burgdorferi)", manufacturer: "Zoetis", nextDueMonths: 12 },
    { name: "Canine Influenza (H3N2/H3N8)", manufacturer: "Zoetis", nextDueMonths: 12 },
    { name: "Leptospirosis", manufacturer: "Nobivac", nextDueMonths: 12 },
    { name: "FVRCP (Feline Viral Rhinotracheitis/Calicivirus/Panleukopenia)", manufacturer: "Boehringer Ingelheim", nextDueMonths: 12 },
    { name: "FeLV (Feline Leukemia)", manufacturer: "Boehringer Ingelheim", nextDueMonths: 12 },
    { name: "Rabies (1-year, feline)", manufacturer: "Boehringer Ingelheim", nextDueMonths: 12 },
  ];

  const vaccinationValues: {
    practiceId: string;
    patientId: string;
    vaccineName: string;
    lotNumber: string;
    manufacturer: string;
    administeredBy: string;
    administeredAt: Date;
    nextDueDate: string;
  }[] = [];

  // Dogs get DHPP, Rabies, Bordetella; Cats get FVRCP, Rabies, FeLV
  for (const patient of insertedPatients) {
    const pData = patientsData[insertedPatients.indexOf(patient)]!;
    let applicableVaccines: typeof vaccineData;
    if (pData.species === "canine") {
      applicableVaccines = vaccineData.filter((v) =>
        ["DHPP", "Rabies (3-year)", "Bordetella", "Lyme", "Leptospirosis"].some((n) => v.name.startsWith(n))
      );
    } else if (pData.species === "feline") {
      applicableVaccines = vaccineData.filter((v) =>
        ["FVRCP", "FeLV", "Rabies (1-year"].some((n) => v.name.startsWith(n))
      );
    } else if (pData.species === "rabbit") {
      // Rabbits: RHDV2
      applicableVaccines = [{ name: "RHDV2 (Rabbit Hemorrhagic Disease)", manufacturer: "Medgene", nextDueMonths: 12 }];
    } else {
      continue; // Birds/reptiles — skip vaccines
    }

    // Give 1-3 vaccines per patient
    const numVax = 1 + Math.floor(Math.random() * Math.min(3, applicableVaccines.length));
    const selectedVax = pickN(applicableVaccines, numVax);

    for (const vax of selectedVax) {
      const adminDate = daysAgo(Math.floor(Math.random() * 180) + 30);
      const nextDue = new Date(adminDate);
      nextDue.setMonth(nextDue.getMonth() + vax.nextDueMonths);

      vaccinationValues.push({
        practiceId,
        patientId: patient.id,
        vaccineName: vax.name,
        lotNumber: `LOT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        manufacturer: vax.manufacturer,
        administeredBy: pickRandom(vets).id,
        administeredAt: adminDate,
        nextDueDate: dateStr(nextDue),
      });
    }
  }

  await db.insert(vaccinationRecords).values(vaccinationValues);
  console.log(`Vaccination records: ${vaccinationValues.length} created`);

  // =========================================================================
  // 11. Prescriptions
  // =========================================================================
  const prescriptionData = [
    { medicationName: "Rimadyl (Carprofen)", dosage: "75mg", frequency: "BID with food", quantity: 60, instructions: "Give one tablet by mouth twice daily with food. Monitor for GI upset. Do not use with other NSAIDs or corticosteroids." },
    { medicationName: "Metacam (Meloxicam)", dosage: "0.1mg/kg", frequency: "SID", quantity: 30, instructions: "Administer orally once daily. Use provided syringe for accurate dosing. Give with food." },
    { medicationName: "Clavamox (Amoxicillin/Clavulanate)", dosage: "250mg", frequency: "BID", quantity: 28, instructions: "Give one tablet by mouth twice daily for 14 days. Complete full course of antibiotics even if symptoms improve." },
    { medicationName: "Apoquel (Oclacitinib)", dosage: "16mg", frequency: "BID x14d then SID", quantity: 42, instructions: "Give one tablet twice daily for 14 days, then once daily for maintenance. Monitor for infections." },
    { medicationName: "Gabapentin", dosage: "100mg", frequency: "BID", quantity: 60, instructions: "Give one capsule by mouth twice daily for pain management. May cause sedation initially." },
    { medicationName: "Cerenia (Maropitant)", dosage: "24mg", frequency: "SID x5d", quantity: 5, instructions: "Give one tablet once daily for up to 5 days for nausea/vomiting. Can be given with or without food." },
    { medicationName: "Trazodone", dosage: "50mg", frequency: "BID PRN", quantity: 30, instructions: "Give one tablet by mouth twice daily as needed for anxiety. May cause sedation." },
    { medicationName: "Prednisone", dosage: "10mg", frequency: "SID tapering", quantity: 21, instructions: "Day 1-7: 2 tablets daily. Day 8-14: 1 tablet daily. Day 15-21: 1 tablet every other day. Give with food." },
    { medicationName: "Vetmedin (Pimobendan)", dosage: "2.5mg", frequency: "BID", quantity: 60, instructions: "Give one tablet by mouth twice daily, 1 hour before food. Do not give with food. Essential for cardiac function." },
    { medicationName: "Convenia (Cefovecin)", dosage: "8mg/kg", frequency: "Single injection", quantity: 1, instructions: "Single subcutaneous injection administered in clinic. Provides 14 days of antibiotic coverage." },
    { medicationName: "Metronidazole", dosage: "250mg", frequency: "BID x10d", quantity: 20, instructions: "Give one tablet by mouth twice daily for 10 days. May cause decreased appetite. Complete full course." },
    { medicationName: "Fortiflora (Probiotic)", dosage: "1 sachet", frequency: "SID", quantity: 30, instructions: "Sprinkle one sachet on food once daily. Can be used long-term for GI health." },
  ];

  const prescriptionValues = [];
  // Create ~15 prescriptions for various patients
  for (let i = 0; i < 15; i++) {
    const rx = prescriptionData[i % prescriptionData.length]!;
    const patient = pickRandom(insertedPatients.slice(0, 20)); // mostly dogs/cats
    const startDate = daysAgo(crypto.randomInt(60));
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + (rx.quantity / (rx.frequency.includes("BID") ? 2 : 1)));

    const isCompleted = endDate < new Date();
    prescriptionValues.push({
      practiceId,
      patientId: patient.id,
      medicationName: rx.medicationName,
      dosage: rx.dosage,
      frequency: rx.frequency,
      quantity: rx.quantity,
      refillsRemaining: isCompleted ? 0 : Math.floor(Math.random() * 3),
      prescribedBy: pickRandom(vets).id,
      startDate: dateStr(startDate),
      endDate: dateStr(endDate),
      status: isCompleted ? ("completed" as const) : ("active" as const),
      instructions: rx.instructions,
    });
  }

  await db.insert(prescriptions).values(prescriptionValues);
  console.log(`Prescriptions: ${prescriptionValues.length} created`);

  // =========================================================================
  // 11b. Lab Results
  // =========================================================================
  const labTestData = [
    { testName: "CBC (Complete Blood Count)", unit: "x10^9/L", low: "5.5", high: "16.9", normalValue: () => (5.5 + Math.random() * 11.4).toFixed(1) },
    { testName: "BUN (Blood Urea Nitrogen)", unit: "mg/dL", low: "7.0", high: "27.0", normalValue: () => (7 + Math.random() * 20).toFixed(1) },
    { testName: "Creatinine", unit: "mg/dL", low: "0.5", high: "1.8", normalValue: () => (0.5 + Math.random() * 1.3).toFixed(2) },
    { testName: "ALT (Alanine Aminotransferase)", unit: "U/L", low: "10.0", high: "125.0", normalValue: () => (10 + Math.random() * 115).toFixed(0) },
    { testName: "Glucose", unit: "mg/dL", low: "74.0", high: "143.0", normalValue: () => (74 + Math.random() * 69).toFixed(0) },
    { testName: "Total Protein", unit: "g/dL", low: "5.2", high: "8.2", normalValue: () => (5.2 + Math.random() * 3).toFixed(1) },
    { testName: "Urinalysis - Specific Gravity", unit: "", low: "1.015", high: "1.045", normalValue: () => (1.015 + Math.random() * 0.03).toFixed(3) },
    { testName: "T4 (Thyroid)", unit: "ug/dL", low: "1.0", high: "4.0", normalValue: () => (1 + Math.random() * 3).toFixed(1) },
    { testName: "Alkaline Phosphatase (ALP)", unit: "U/L", low: "23.0", high: "212.0", normalValue: () => (23 + Math.random() * 189).toFixed(0) },
    { testName: "Albumin", unit: "g/dL", low: "2.3", high: "4.0", normalValue: () => (2.3 + Math.random() * 1.7).toFixed(1) },
  ];

  const labResultValues: (typeof labResults.$inferInsert)[] = [];

  // Create 12 lab results across different patients. Pending rows intentionally
  // carry no partial values; completed/reviewed rows carry explicit evidence.
  const labPatients = pickN(insertedPatients.slice(0, 20), 8);
  for (let i = 0; i < 12; i++) {
    const patient = labPatients[i % labPatients.length]!;
    const test = labTestData[i % labTestData.length]!;
    const vet = pickRandom(vets);

    let measuredValue: string;
    if (i === 1) {
      measuredValue = "42.5";
    } else if (i === 3) {
      measuredValue = "198";
    } else if (i === 7) {
      measuredValue = "0.6";
    } else {
      measuredValue = test.normalValue();
    }

    const status: "pending" | "completed" | "reviewed" =
      i < 3 ? "pending" : i < 7 ? "completed" : "reviewed";
    const hasValues = status !== "pending";
    const createdAt = daysAgo(14 - i);
    const completedAt = hasValues ? addMinutes(createdAt, 30) : null;
    const reviewedAt = status === "reviewed"
      ? addMinutes(completedAt!, 45)
      : null;
    const creationOperationId = crypto.randomUUID();
    const creationPayloadHash = crypto
      .createHash("sha256")
      .update(`seed:lab:create:${creationOperationId}`)
      .digest("hex");
    const resultFlag = status === "pending"
      ? "unknown"
      : i === 3 || i === 7
        ? "abnormal"
        : "normal";

    labResultValues.push({
      practiceId,
      patientId: patient.id,
      creationOperationId,
      creationPayloadHash,
      testName: test.testName,
      resultValue: hasValues ? measuredValue : null,
      unit: hasValues ? test.unit : null,
      referenceRangeLow: hasValues ? test.low : null,
      referenceRangeHigh: hasValues ? test.high : null,
      status,
      resultFlag,
      orderedBy: vet.id,
      completedAt,
      reviewedBy: status === "reviewed" ? vet.id : null,
      reviewedAt,
      createdAt,
      updatedAt: reviewedAt ?? completedAt ?? createdAt,
    });
  }

  const insertedLabResults = await db
    .insert(labResults)
    .values(labResultValues)
    .returning();

  const userNameById = new Map(insertedUsers.map((user) => [user.id, user.name]));
  const labEventValues: (typeof labResultEvents.$inferInsert)[] = [];
  for (const result of insertedLabResults) {
    const actorName = userNameById.get(result.orderedBy ?? "") ?? "Seed clinician";
    labEventValues.push({
      practiceId,
      labResultId: result.id,
      patientId: result.patientId,
      appointmentId: result.appointmentId,
      eventType: "created",
      statusBefore: null,
      statusAfter: "pending",
      resultValue: null,
      unit: null,
      referenceRangeLow: null,
      referenceRangeHigh: null,
      resultFlag: "unknown",
      followUpStatus: "not_required",
      actorId: result.orderedBy!,
      actorName,
      createdAt: result.createdAt,
      operationId: result.creationOperationId!,
      operationPayloadHash: result.creationPayloadHash!,
    });
    if (result.status !== "pending") {
      const completionOperationId = crypto.randomUUID();
      labEventValues.push({
        practiceId,
        labResultId: result.id,
        patientId: result.patientId,
        appointmentId: result.appointmentId,
        eventType: "completed",
        statusBefore: "pending",
        statusAfter: "completed",
        resultValue: result.resultValue,
        unit: result.unit,
        referenceRangeLow: result.referenceRangeLow,
        referenceRangeHigh: result.referenceRangeHigh,
        resultFlag: result.resultFlag,
        followUpStatus: "not_required",
        actorId: result.orderedBy!,
        actorName,
        note: "Seeded result values recorded.",
        createdAt: result.completedAt!,
        operationId: completionOperationId,
        operationPayloadHash: crypto
          .createHash("sha256")
          .update(`seed:lab:complete:${completionOperationId}`)
          .digest("hex"),
      });
    }
    if (result.status === "reviewed") {
      const reviewOperationId = crypto.randomUUID();
      labEventValues.push({
        practiceId,
        labResultId: result.id,
        patientId: result.patientId,
        appointmentId: result.appointmentId,
        eventType: "reviewed",
        statusBefore: "completed",
        statusAfter: "reviewed",
        resultValue: result.resultValue,
        unit: result.unit,
        referenceRangeLow: result.referenceRangeLow,
        referenceRangeHigh: result.referenceRangeHigh,
        resultFlag: result.resultFlag,
        followUpStatus: "not_required",
        actorId: result.reviewedBy!,
        actorName,
        createdAt: result.reviewedAt!,
        operationId: reviewOperationId,
        operationPayloadHash: crypto
          .createHash("sha256")
          .update(`seed:lab:review:${reviewOperationId}`)
          .digest("hex"),
      });
    }
  }
  await db.insert(labResultEvents).values(labEventValues);
  const enteredInErrorSource = insertedLabResults.find(
    (result) => result.status === "completed",
  );
  if (!enteredInErrorSource?.orderedBy) {
    throw new Error("Demo lab correction fixture requires a completed source.");
  }
  const correctionOperationId = crypto.randomUUID();
  const correctionPayloadHash = crypto
    .createHash("sha256")
    .update(`seed:lab:entered-in-error:${correctionOperationId}`)
    .digest("hex");
  const correctionCreatedAt = addMinutes(
    enteredInErrorSource.completedAt ?? enteredInErrorSource.createdAt,
    5,
  );
  const [labCorrection] = await db
    .insert(clinicalRecordCorrections)
    .values({
      practiceId,
      recordType: "lab_result",
      action: "entered_in_error",
      labResultId: enteredInErrorSource.id,
      patientId: enteredInErrorSource.patientId,
      appointmentId: enteredInErrorSource.appointmentId,
      reason:
        "Incorrect transcribed value retained for demonstration and audit.",
      correctedBy: enteredInErrorSource.orderedBy,
      correctedByName:
        userNameById.get(enteredInErrorSource.orderedBy) ?? "Seed clinician",
      operationId: correctionOperationId,
      operationPayloadHash: correctionPayloadHash,
      createdAt: correctionCreatedAt,
    })
    .returning();
  const replacementOperationId = crypto.randomUUID();
  const replacementPayloadHash = crypto
    .createHash("sha256")
    .update(`seed:lab:replacement:${replacementOperationId}`)
    .digest("hex");
  const replacementCreatedAt = addMinutes(correctionCreatedAt, 5);
  const replacementCompletedAt = addMinutes(replacementCreatedAt, 15);
  const replacementReviewedAt = addMinutes(replacementCompletedAt, 10);
  const replacementValue = "87";
  const [replacementResult] = await db
    .insert(labResults)
    .values({
      practiceId,
      patientId: enteredInErrorSource.patientId,
      creationOperationId: replacementOperationId,
      creationPayloadHash: replacementPayloadHash,
      testName: enteredInErrorSource.testName,
      resultValue: replacementValue,
      unit: enteredInErrorSource.unit,
      referenceRangeLow: enteredInErrorSource.referenceRangeLow,
      referenceRangeHigh: enteredInErrorSource.referenceRangeHigh,
      status: "reviewed",
      resultFlag: "normal",
      orderedBy: enteredInErrorSource.orderedBy,
      completedAt: replacementCompletedAt,
      reviewedBy: enteredInErrorSource.orderedBy,
      reviewedAt: replacementReviewedAt,
      createdAt: replacementCreatedAt,
      updatedAt: replacementReviewedAt,
    })
    .returning();
  const replacementCompletionOperationId = crypto.randomUUID();
  const replacementReviewOperationId = crypto.randomUUID();
  const replacementActorName =
    userNameById.get(enteredInErrorSource.orderedBy) ?? "Seed clinician";
  await db.insert(labResultEvents).values([
    {
      practiceId,
      labResultId: replacementResult!.id,
      patientId: replacementResult!.patientId,
      appointmentId: null,
      eventType: "created",
      statusBefore: null,
      statusAfter: "pending",
      resultValue: null,
      unit: null,
      referenceRangeLow: null,
      referenceRangeHigh: null,
      resultFlag: "unknown",
      followUpStatus: "not_required",
      actorId: enteredInErrorSource.orderedBy,
      actorName: replacementActorName,
      createdAt: replacementCreatedAt,
      operationId: replacementOperationId,
      operationPayloadHash: replacementPayloadHash,
    },
    {
      practiceId,
      labResultId: replacementResult!.id,
      patientId: replacementResult!.patientId,
      appointmentId: null,
      eventType: "completed",
      statusBefore: "pending",
      statusAfter: "completed",
      resultValue: replacementValue,
      unit: replacementResult!.unit,
      referenceRangeLow: replacementResult!.referenceRangeLow,
      referenceRangeHigh: replacementResult!.referenceRangeHigh,
      resultFlag: "normal",
      followUpStatus: "not_required",
      actorId: enteredInErrorSource.orderedBy,
      actorName: replacementActorName,
      note: "Fresh replacement value recorded after correction.",
      createdAt: replacementCompletedAt,
      operationId: replacementCompletionOperationId,
      operationPayloadHash: crypto
        .createHash("sha256")
        .update(
          `seed:lab:replacement-complete:${replacementCompletionOperationId}`,
        )
        .digest("hex"),
    },
    {
      practiceId,
      labResultId: replacementResult!.id,
      patientId: replacementResult!.patientId,
      appointmentId: null,
      eventType: "reviewed",
      statusBefore: "completed",
      statusAfter: "reviewed",
      resultValue: replacementValue,
      unit: replacementResult!.unit,
      referenceRangeLow: replacementResult!.referenceRangeLow,
      referenceRangeHigh: replacementResult!.referenceRangeHigh,
      resultFlag: "normal",
      followUpStatus: "not_required",
      actorId: enteredInErrorSource.orderedBy,
      actorName: replacementActorName,
      createdAt: replacementReviewedAt,
      operationId: replacementReviewOperationId,
      operationPayloadHash: crypto
        .createHash("sha256")
        .update(`seed:lab:replacement-review:${replacementReviewOperationId}`)
        .digest("hex"),
    },
  ]);
  await db.insert(labResultReplacements).values({
    practiceId,
    correctionId: labCorrection!.id,
    sourceLabResultId: enteredInErrorSource.id,
    replacementLabResultId: replacementResult!.id,
    actorId: enteredInErrorSource.orderedBy,
    actorName: replacementActorName,
    operationId: replacementOperationId,
    operationPayloadHash: replacementPayloadHash,
    createdAt: replacementCreatedAt,
  });
  console.log(
    `Lab results: ${insertedLabResults.length + 1} created with ${labEventValues.length + 3} evidence events`,
  );

  // =========================================================================
  // 11c. Procedures
  // =========================================================================
  const procedureData = [
    { name: "Dental Prophylaxis", description: "Full dental cleaning with scaling and polishing under general anesthesia", anesthesiaUsed: "Isoflurane + Propofol induction", durationMinutes: 60 },
    { name: "Mass Removal", description: "Surgical excision of subcutaneous mass on right flank, submitted for histopathology", anesthesiaUsed: "Isoflurane + local lidocaine block", durationMinutes: 45 },
    { name: "Laceration Repair", description: "Wound debridement and primary closure of 4cm laceration on left forelimb", anesthesiaUsed: "Sedation (Dexdomitor) + local lidocaine", durationMinutes: 30 },
    { name: "Foreign Body Removal", description: "Endoscopic retrieval of sock fragment from stomach", anesthesiaUsed: "Isoflurane general anesthesia", durationMinutes: 90 },
    { name: "Spay (Ovariohysterectomy)", description: "Routine ovariohysterectomy via ventral midline approach", anesthesiaUsed: "Isoflurane + Propofol induction + Meloxicam", durationMinutes: 45 },
    { name: "Neuter (Orchiectomy)", description: "Routine castration, pre-scrotal approach, closed technique", anesthesiaUsed: "Isoflurane + Propofol induction", durationMinutes: 25 },
    { name: "Cystotomy", description: "Surgical removal of bladder stones via ventral cystotomy", anesthesiaUsed: "Isoflurane general anesthesia + epidural", durationMinutes: 75 },
  ];

  const procedureValues: {
    practiceId: string;
    patientId: string;
    name: string;
    description: string;
    performedBy: string;
    anesthesiaUsed: string;
    durationMinutes: number;
    notes: string;
  }[] = [];

  const procPatients = pickN(insertedPatients.slice(0, 20), 7);
  for (let i = 0; i < 7; i++) {
    const patient = procPatients[i % procPatients.length]!;
    const proc = procedureData[i]!;
    const vet = pickRandom(vets);

    procedureValues.push({
      practiceId,
      patientId: patient.id,
      name: proc.name,
      description: proc.description,
      performedBy: vet.id,
      anesthesiaUsed: proc.anesthesiaUsed,
      durationMinutes: proc.durationMinutes,
      notes: `Patient recovered well. Post-op monitoring for ${Math.floor(proc.durationMinutes / 2)} minutes. Discharged with standard post-operative instructions.`,
    });
  }

  await db.insert(procedures).values(procedureValues);
  console.log(`Procedures: ${procedureValues.length} created`);

  // =========================================================================
  // 12. Services
  // =========================================================================
  const servicesData = [
    { name: "Wellness Examination", code: "EXAM-WE", category: "Exam", defaultPrice: "65.00" },
    { name: "Sick Visit Examination", code: "EXAM-SV", category: "Exam", defaultPrice: "75.00" },
    { name: "Surgery Consultation", code: "EXAM-SC", category: "Exam", defaultPrice: "85.00" },
    { name: "Dental Prophylaxis", code: "DENT-01", category: "Dental", defaultPrice: "350.00" },
    { name: "Tooth Extraction (simple)", code: "DENT-02", category: "Dental", defaultPrice: "150.00" },
    { name: "Spay (under 50 lbs)", code: "SURG-01", category: "Surgery", defaultPrice: "400.00" },
    { name: "Neuter (under 50 lbs)", code: "SURG-02", category: "Surgery", defaultPrice: "300.00" },
    { name: "Mass Removal", code: "SURG-03", category: "Surgery", defaultPrice: "500.00" },
    { name: "Radiograph (2 views)", code: "DIAG-01", category: "Diagnostic", defaultPrice: "185.00" },
    { name: "CBC/Chemistry Panel", code: "LAB-01", category: "Lab", defaultPrice: "145.00" },
    { name: "Urinalysis", code: "LAB-02", category: "Lab", defaultPrice: "55.00" },
    { name: "Fecal Float", code: "LAB-03", category: "Lab", defaultPrice: "35.00" },
    { name: "DHPP Vaccine", code: "VAX-01", category: "Vaccine", defaultPrice: "28.00" },
    { name: "Rabies Vaccine", code: "VAX-02", category: "Vaccine", defaultPrice: "22.00" },
    { name: "Bordetella Vaccine", code: "VAX-03", category: "Vaccine", defaultPrice: "25.00" },
    { name: "FVRCP Vaccine", code: "VAX-04", category: "Vaccine", defaultPrice: "28.00" },
    { name: "FeLV Vaccine", code: "VAX-05", category: "Vaccine", defaultPrice: "30.00" },
    { name: "Nail Trim", code: "GROO-01", category: "Grooming", defaultPrice: "18.00" },
    { name: "Anal Gland Expression", code: "GROO-02", category: "Grooming", defaultPrice: "25.00" },
    { name: "Microchip Implantation", code: "MISC-01", category: "Misc", defaultPrice: "55.00" },
  ];

  const insertedServices = await db
    .insert(services)
    .values(servicesData.map((s) => ({ ...s, practiceId, taxable: true })))
    .returning();
  console.log(`Services: ${insertedServices.length} created`);

  // =========================================================================
  // 13. Invoices (various states)
  // =========================================================================
  const invoiceStatuses: ("draft" | "sent" | "paid" | "overdue")[] = [
    "paid", "paid", "paid", "paid", "paid",
    "paid", "paid", "sent", "sent", "sent",
    "draft", "draft", "overdue", "overdue",
  ];

  const invoiceValues: {
    practiceId: string;
    clientId: string;
    patientId: string;
    appointmentId: string | null;
    status: "draft" | "sent" | "paid" | "overdue";
    subtotal: string;
    tax: string;
    total: string;
    paidAmount: string;
    dueDate: string;
    createdAt: Date;
  }[] = [];

  for (let i = 0; i < invoiceStatuses.length; i++) {
    const status = invoiceStatuses[i]!;
    const client = insertedClients[i % insertedClients.length]!;
    const patientIdx = patientsData.findIndex(
      (p) => insertedClients[p.clientIdx]?.id === client.id
    );
    const patient = patientIdx >= 0 ? insertedPatients[patientIdx]! : insertedPatients[0]!;
    const appt = i < insertedAppointments.length ? insertedAppointments[i]! : null;

    const subtotal = (50 + Math.floor(Math.random() * 400)).toFixed(2);
    const tax = (parseFloat(subtotal) * 0.08).toFixed(2);
    const total = (parseFloat(subtotal) + parseFloat(tax)).toFixed(2);
    const paidAmount = status === "paid" ? total : status === "overdue" ? "0.00" : "0.00";

    // Issue every invoice before its due date so no invoice reads as "due
    // before it was created" in the UI.
    let dueDate: string;
    let createdAt: Date;
    if (status === "paid") {
      const dueDaysAgo = Math.floor(Math.random() * 30);
      createdAt = daysAgo(dueDaysAgo + 14);
      dueDate = dateStr(daysAgo(dueDaysAgo));
    } else if (status === "overdue") {
      const dueDaysAgo = Math.floor(Math.random() * 14) + 1;
      createdAt = daysAgo(dueDaysAgo + 14);
      dueDate = dateStr(daysAgo(dueDaysAgo));
    } else {
      createdAt = daysAgo(Math.floor(Math.random() * 5));
      dueDate = dateStr(daysFromNow(30));
    }

    invoiceValues.push({
      practiceId,
      clientId: client.id,
      patientId: patient.id,
      appointmentId: appt?.id ?? null,
      status,
      subtotal,
      tax,
      total,
      paidAmount,
      dueDate,
      createdAt,
    });
  }

  const insertedInvoices = await db
    .insert(invoices)
    .values(invoiceValues)
    .returning();
  console.log(`Invoices: ${insertedInvoices.length} created`);

  // Invoice items
  const invoiceItemValues: {
    invoiceId: string;
    description: string;
    quantity: number;
    unitPrice: string;
    total: string;
    taxable: boolean;
    itemType: "service" | "product";
  }[] = [];

  for (const inv of insertedInvoices) {
    const numItems = 1 + Math.floor(Math.random() * 4);
    let runningTotal = 0;

    for (let j = 0; j < numItems; j++) {
      const svc = pickRandom(insertedServices);
      const qty = 1;
      const unitPrice = svc.defaultPrice;
      const itemTotal = (parseFloat(unitPrice) * qty).toFixed(2);
      runningTotal += parseFloat(itemTotal);

      invoiceItemValues.push({
        invoiceId: inv.id,
        description: svc.name,
        quantity: qty,
        unitPrice,
        total: itemTotal,
        taxable: svc.taxable,
        itemType: "service",
      });
    }
  }

  await db.insert(invoiceItems).values(invoiceItemValues);
  console.log(`Invoice items: ${invoiceItemValues.length} created`);

  // =========================================================================
  // 14. Products (50)
  // =========================================================================
  const productsData = [
    // Medications
    { name: "Rimadyl 75mg tablet", sku: "MED-001", category: "Medication", unitPrice: "1.42", costPrice: "0.70", stockQuantity: 2700, reorderPoint: 900 },
    { name: "Metacam 1.5mg/mL oral suspension — per mL", sku: "MED-002", category: "Medication", unitPrice: "2.03", costPrice: "1.00", stockQuantity: 960, reorderPoint: 320 },
    { name: "Clavamox 250mg tablet", sku: "MED-003", category: "Medication", unitPrice: "1.71", costPrice: "0.79", stockQuantity: 1400, reorderPoint: 420 },
    { name: "Apoquel 16mg tablet", sku: "MED-004", category: "Medication", unitPrice: "4.17", costPrice: "2.60", stockQuantity: 750, reorderPoint: 300 },
    { name: "Gabapentin 100mg capsule", sku: "MED-005", category: "Medication", unitPrice: "0.58", costPrice: "0.20", stockQuantity: 3600, reorderPoint: 1200 },
    { name: "Cerenia 24mg tablet", sku: "MED-006", category: "Medication", unitPrice: "23.75", costPrice: "13.75", stockQuantity: 80, reorderPoint: 32 },
    { name: "Trazodone 50mg tablet", sku: "MED-007", category: "Medication", unitPrice: "0.93", costPrice: "0.33", stockQuantity: 1200, reorderPoint: 450 },
    { name: "Prednisone 10mg tablet", sku: "MED-008", category: "Medication", unitPrice: "0.50", costPrice: "0.17", stockQuantity: 1650, reorderPoint: 600 },
    { name: "Vetmedin 2.5mg tablet", sku: "MED-009", category: "Medication", unitPrice: "2.90", costPrice: "1.76", stockQuantity: 750, reorderPoint: 250 },
    { name: "Metronidazole 250mg tablet", sku: "MED-010", category: "Medication", unitPrice: "0.73", costPrice: "0.27", stockQuantity: 1500, reorderPoint: 450 },
    { name: "Doxycycline 100mg tablet", sku: "MED-011", category: "Medication", unitPrice: "1.07", costPrice: "0.40", stockQuantity: 1200, reorderPoint: 450 },
    { name: "Enrofloxacin 68mg tablet", sku: "MED-012", category: "Medication", unitPrice: "1.10", costPrice: "0.56", stockQuantity: 1500, reorderPoint: 500 },
    { name: "Cephalexin 500mg capsule", sku: "MED-013", category: "Medication", unitPrice: "0.45", costPrice: "0.18", stockQuantity: 3500, reorderPoint: 1200 },
    { name: "Tramadol 50mg tablet", sku: "MED-014", category: "Medication", unitPrice: "0.63", costPrice: "0.25", stockQuantity: 1500, reorderPoint: 600 },
    { name: "Enalapril 5mg tablet", sku: "MED-015", category: "Medication", unitPrice: "0.42", costPrice: "0.13", stockQuantity: 1800, reorderPoint: 600 },
    // Preventives
    { name: "Heartgard Plus (26-50 lbs, 6ct)", sku: "PREV-001", category: "Preventive", unitPrice: "55.00", costPrice: "32.00", stockQuantity: 40, reorderPoint: 15 },
    { name: "NexGard (24.1-60 lbs, 6ct)", sku: "PREV-002", category: "Preventive", unitPrice: "120.00", costPrice: "72.00", stockQuantity: 35, reorderPoint: 12 },
    { name: "Simparica Trio (22.1-44 lbs, 6ct)", sku: "PREV-003", category: "Preventive", unitPrice: "135.00", costPrice: "82.00", stockQuantity: 28, reorderPoint: 10 },
    { name: "Revolution Plus (5.6-11 lbs cat, 6ct)", sku: "PREV-004", category: "Preventive", unitPrice: "125.00", costPrice: "75.00", stockQuantity: 25, reorderPoint: 10 },
    { name: "Bravecto (22-44 lbs, 1ct)", sku: "PREV-005", category: "Preventive", unitPrice: "58.00", costPrice: "35.00", stockQuantity: 30, reorderPoint: 10 },
    // Supplements
    { name: "Fortiflora Canine (30 sachets)", sku: "SUP-001", category: "Supplement", unitPrice: "32.00", costPrice: "18.00", stockQuantity: 45, reorderPoint: 15 },
    { name: "Fortiflora Feline (30 sachets)", sku: "SUP-002", category: "Supplement", unitPrice: "32.00", costPrice: "18.00", stockQuantity: 35, reorderPoint: 12 },
    { name: "Dasuquin Advanced (84ct)", sku: "SUP-003", category: "Supplement", unitPrice: "65.00", costPrice: "38.00", stockQuantity: 25, reorderPoint: 8 },
    { name: "Welactin Omega-3 (120 softgels)", sku: "SUP-004", category: "Supplement", unitPrice: "42.00", costPrice: "22.00", stockQuantity: 20, reorderPoint: 8 },
    { name: "Cosequin DS Plus MSM (132ct)", sku: "SUP-005", category: "Supplement", unitPrice: "55.00", costPrice: "30.00", stockQuantity: 22, reorderPoint: 8 },
    // Food
    { name: "Hill's Science Diet Adult (30 lb)", sku: "FOOD-001", category: "Food", unitPrice: "72.00", costPrice: "45.00", stockQuantity: 15, reorderPoint: 5 },
    { name: "Royal Canin GI Low Fat (17.6 lb)", sku: "FOOD-002", category: "Food", unitPrice: "85.00", costPrice: "52.00", stockQuantity: 12, reorderPoint: 4 },
    { name: "Hill's Prescription Diet k/d (8.5 lb)", sku: "FOOD-003", category: "Food", unitPrice: "48.00", costPrice: "28.00", stockQuantity: 10, reorderPoint: 4 },
    { name: "Royal Canin Urinary SO (17.6 lb)", sku: "FOOD-004", category: "Food", unitPrice: "78.00", costPrice: "48.00", stockQuantity: 8, reorderPoint: 3 },
    { name: "Hill's Science Diet Kitten (7 lb)", sku: "FOOD-005", category: "Food", unitPrice: "32.00", costPrice: "18.00", stockQuantity: 10, reorderPoint: 4 },
    { name: "Purina Pro Plan Sensitive Skin (30 lb)", sku: "FOOD-006", category: "Food", unitPrice: "62.00", costPrice: "38.00", stockQuantity: 12, reorderPoint: 4 },
    { name: "Royal Canin Hydrolyzed Protein (17.6 lb)", sku: "FOOD-007", category: "Food", unitPrice: "92.00", costPrice: "58.00", stockQuantity: 6, reorderPoint: 3 },
    { name: "Hill's i/d Digestive Care (8.5 lb)", sku: "FOOD-008", category: "Food", unitPrice: "45.00", costPrice: "26.00", stockQuantity: 14, reorderPoint: 5 },
    // Supplies
    { name: "Elizabethan Collar (Medium)", sku: "SUP-S01", category: "Supply", unitPrice: "15.00", costPrice: "5.00", stockQuantity: 30, reorderPoint: 10 },
    { name: "Elizabethan Collar (Large)", sku: "SUP-S02", category: "Supply", unitPrice: "18.00", costPrice: "6.00", stockQuantity: 25, reorderPoint: 10 },
    { name: "Pill Pockets - Chicken (30ct)", sku: "SUP-S03", category: "Supply", unitPrice: "12.00", costPrice: "6.00", stockQuantity: 50, reorderPoint: 15 },
    { name: "Pill Pockets - Peanut Butter (30ct)", sku: "SUP-S04", category: "Supply", unitPrice: "12.00", costPrice: "6.00", stockQuantity: 45, reorderPoint: 15 },
    { name: "Gentle Leader Headcollar (Medium)", sku: "SUP-S05", category: "Supply", unitPrice: "22.00", costPrice: "12.00", stockQuantity: 15, reorderPoint: 5 },
    { name: "Microchip (HomeAgain)", sku: "SUP-S06", category: "Supply", unitPrice: "35.00", costPrice: "18.00", stockQuantity: 40, reorderPoint: 15 },
    { name: "Vetrap Bandage (4 in x 5 yd)", sku: "SUP-S07", category: "Supply", unitPrice: "4.00", costPrice: "1.50", stockQuantity: 100, reorderPoint: 30 },
    { name: "Adhesive Bandage Roll", sku: "SUP-S08", category: "Supply", unitPrice: "6.00", costPrice: "2.00", stockQuantity: 80, reorderPoint: 25 },
    { name: "Ear Cleaner (8 oz)", sku: "SUP-S09", category: "Supply", unitPrice: "14.00", costPrice: "7.00", stockQuantity: 35, reorderPoint: 10 },
    { name: "Chlorhexidine Flush (8 oz)", sku: "SUP-S10", category: "Supply", unitPrice: "16.00", costPrice: "8.00", stockQuantity: 30, reorderPoint: 10 },
    { name: "Dental Chews (Large, 30ct)", sku: "SUP-S11", category: "Supply", unitPrice: "28.00", costPrice: "14.00", stockQuantity: 25, reorderPoint: 8 },
    { name: "Syringes 3mL (100ct)", sku: "SUP-S12", category: "Supply", unitPrice: "18.00", costPrice: "8.00", stockQuantity: 20, reorderPoint: 5 },
    { name: "IV Catheter 20ga (50ct)", sku: "SUP-S13", category: "Supply", unitPrice: "45.00", costPrice: "22.00", stockQuantity: 15, reorderPoint: 5 },
    { name: "Surgical Gloves (Medium, 100ct)", sku: "SUP-S14", category: "Supply", unitPrice: "25.00", costPrice: "12.00", stockQuantity: 18, reorderPoint: 5 },
    { name: "KY Jelly Lubricant (4 oz)", sku: "SUP-S15", category: "Supply", unitPrice: "8.00", costPrice: "3.00", stockQuantity: 20, reorderPoint: 8 },
    { name: "Fecal Sample Container (50ct)", sku: "SUP-S16", category: "Supply", unitPrice: "15.00", costPrice: "6.00", stockQuantity: 25, reorderPoint: 8 },
    { name: "Pet Nail Clipper (Professional)", sku: "SUP-S17", category: "Supply", unitPrice: "18.00", costPrice: "8.00", stockQuantity: 10, reorderPoint: 3 },
  ];

  const insertedProducts = await db
    .insert(products)
    .values(
      productsData.map((p) => ({
        practiceId,
        locationId,
        name: p.name,
        sku: p.sku,
        category: p.category,
        unitPrice: p.unitPrice,
        taxable: true,
        costPrice: p.costPrice,
        stockQuantity: p.stockQuantity,
        reorderPoint: p.reorderPoint,
      }))
    )
    .returning();
  console.log(`Products: ${insertedProducts.length} created`);

  // =========================================================================
  // 16. Payments — one per paid invoice
  // =========================================================================
  const frontDeskUsers = insertedUsers.filter((u) => u.role === "front_desk");
  const vetUsers = insertedUsers.filter((u) => u.role === "veterinarian");
  const techUsers = insertedUsers.filter((u) => u.role === "technician");
  const adminUser = insertedUsers.find((u) => u.role === "admin")!;
  const paidInvoices = insertedInvoices.filter((i) => i.status === "paid");
  const paymentMethods = ["credit_card", "credit_card", "debit_card", "cash", "check", "credit_card", "online"] as const;

  const paymentValues = paidInvoices.map((inv, i) => ({
    invoiceId: inv.id,
    amount: inv.total,
    method: paymentMethods[i % paymentMethods.length]!,
    receivedBy: frontDeskUsers[i % frontDeskUsers.length]!.id,
    receivedAt: daysAgo(Math.floor(Math.random() * 14)),
    notes: null,
  }));
  const insertedPayments = await db.insert(payments).values(paymentValues).returning();
  console.log(`Payments: ${insertedPayments.length} created`);

  // =========================================================================
  // 17. Communications — messages, calls, emails, portal
  // =========================================================================
  type CommRow = typeof communications.$inferInsert;
  const commValues: CommRow[] = [];
  const someClients = insertedClients.slice(0, 12);

  // SMS appointment reminders (outbound, delivered)
  for (let i = 0; i < 5; i++) {
    commValues.push({
      practiceId,
      clientId: someClients[i]!.id,
      channel: "sms",
      direction: "outbound",
      subject: null,
      content: `Hi ${someClients[i]!.firstName}, this is Neighborhood Veterinary reminding you of your appointment tomorrow. Reply C to confirm or R to reschedule.`,
      status: "delivered",
      assignedTo: frontDeskUsers[i % frontDeskUsers.length]!.id,
      createdAt: daysAgo(Math.floor(Math.random() * 7)),
    });
  }

  // Emails — wellness reminders + Rx refill reply + invoice copy
  const emailSubjects = [
    { subject: "Annual wellness exam due for your pet", content: "It's time for your yearly wellness visit. Reply to this email or call the clinic to schedule." },
    { subject: "Vaccination booster reminder", content: "Your pet is due for a DHPP booster this month. We have openings on Tuesday and Thursday afternoons." },
    { subject: "Re: Prescription refill for Rimadyl", content: "Thanks for the refill request. We've approved a 30-day refill — pick up anytime this week during office hours." },
    { subject: "Invoice copy — recent visit", content: "Attached is the itemized invoice for your recent visit. Let us know if you have any questions." },
  ];
  emailSubjects.forEach((e, i) => {
    commValues.push({
      practiceId,
      clientId: someClients[5 + i]!.id,
      channel: "email",
      direction: "outbound",
      subject: e.subject,
      content: e.content,
      status: "sent",
      assignedTo: frontDeskUsers[i % frontDeskUsers.length]!.id,
      createdAt: daysAgo(Math.floor(Math.random() * 10) + 1),
    });
  });

  // Portal messages — inbound from clients
  const portalMessages = [
    { subject: "Question about Luna's medication", content: "Is it okay to give Luna her Rimadyl with food? She seems to have an upset stomach after taking it on an empty stomach." },
    { subject: "Rescheduling Tuesday appointment", content: "Hi — my work schedule changed. Can we move Tuesday's appointment to later in the week?" },
    { subject: "Vaccination records needed for boarding", content: "We're boarding Max next weekend. Can you send his vaccination records to the kennel?" },
  ];
  portalMessages.forEach((m, i) => {
    commValues.push({
      practiceId,
      clientId: someClients[9 + i]!.id,
      channel: "portal",
      direction: "inbound",
      subject: m.subject,
      content: m.content,
      status: "delivered",
      assignedTo: i === 0 ? vetUsers[0]!.id : frontDeskUsers[0]!.id,
      createdAt: daysAgo(Math.floor(Math.random() * 5)),
    });
  });

  // Phone call logs
  const callLogs = [
    { content: "Client called about limping on left hind leg, started this morning. Advised to bring in today — booked 3pm slot.", direction: "inbound" as const },
    { content: "Called to confirm surgery consent for tomorrow's dental. Client confirmed drop-off at 7:30am, fasting since 10pm.", direction: "outbound" as const },
    { content: "Post-op check-in call — patient eating normally, sutures look clean. Recheck scheduled in 10 days.", direction: "outbound" as const },
  ];
  callLogs.forEach((c, i) => {
    commValues.push({
      practiceId,
      clientId: someClients[i]!.id,
      channel: "phone",
      direction: c.direction,
      subject: null,
      content: c.content,
      status: "delivered",
      assignedTo: frontDeskUsers[i % frontDeskUsers.length]!.id,
      createdAt: daysAgo(Math.floor(Math.random() * 5)),
    });
  });

  const insertedComms = await db.insert(communications).values(commValues).returning();
  console.log(`Communications: ${insertedComms.length} created`);

  // =========================================================================
  // 18. Audit log — recent practice activity
  // =========================================================================
  type AuditRow = typeof auditLog.$inferInsert;
  const auditValues: AuditRow[] = [];

  const samplePatients = insertedPatients.slice(0, 15);
  const sampleAppts = insertedAppointments.slice(0, 20);
  const sampleInvoicesForAudit = insertedInvoices.slice(0, 10);
  const auditIp = () => `192.168.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

  // Appointment lifecycle events
  sampleAppts.slice(0, 12).forEach((appt, i) => {
    auditValues.push({
      practiceId,
      userId: frontDeskUsers[i % frontDeskUsers.length]!.id,
      action: "appointment.created",
      entityType: "appointment",
      entityId: appt.id,
      changes: { status: "scheduled" },
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 7)),
    });
  });
  sampleAppts.slice(0, 6).forEach((appt, i) => {
    auditValues.push({
      practiceId,
      userId: frontDeskUsers[i % frontDeskUsers.length]!.id,
      action: "appointment.checked_in",
      entityType: "appointment",
      entityId: appt.id,
      changes: { status: "checked_in" },
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 3)),
    });
  });

  // Invoice lifecycle
  sampleInvoicesForAudit.slice(0, 6).forEach((inv, i) => {
    auditValues.push({
      practiceId,
      userId: frontDeskUsers[i % frontDeskUsers.length]!.id,
      action: "invoice.created",
      entityType: "invoice",
      entityId: inv.id,
      changes: { total: inv.total },
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 14)),
    });
  });
  paidInvoices.slice(0, 4).forEach((inv, i) => {
    auditValues.push({
      practiceId,
      userId: frontDeskUsers[i % frontDeskUsers.length]!.id,
      action: "invoice.paid",
      entityType: "invoice",
      entityId: inv.id,
      changes: { status: "paid", paidAmount: inv.total },
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 10)),
    });
  });

  // Patient record edits by vets
  samplePatients.slice(0, 5).forEach((patient, i) => {
    auditValues.push({
      practiceId,
      userId: vetUsers[i % vetUsers.length]!.id,
      action: "patient.updated",
      entityType: "patient",
      entityId: patient.id,
      changes: { weight: "updated" },
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 5)),
    });
  });

  // Login events (practice-level, not tied to an entity)
  [adminUser, ...vetUsers, ...frontDeskUsers].forEach((user, i) => {
    auditValues.push({
      practiceId,
      userId: user.id,
      action: "user.login",
      entityType: "user",
      entityId: user.id,
      changes: null,
      ipAddress: auditIp(),
      createdAt: daysAgo(Math.floor(Math.random() * 2)),
    });
  });

  const insertedAudit = await db.insert(auditLog).values(auditValues).returning();
  console.log(`Audit log entries: ${insertedAudit.length} created`);

  // =========================================================================
  // 19. Controlled substance log — DEA-compliant dispense trail
  // =========================================================================
  type CsLogRow = typeof controlledSubstanceLog.$inferInsert;
  const csEntries: CsLogRow[] = [
    {
      practiceId,
      drugName: "Tramadol HCl 50mg",
      deaSchedule: "IV",
      action: "administered",
      quantity: "2.000",
      unit: "tablet",
      patientId: samplePatients[0]!.id,
      performedBy: vetUsers[0]!.id,
      witnessedBy: techUsers[0]!.id,
      lotNumber: "TR-2026-0318-A",
      notes: "Post-op pain management, dental extraction",
      performedAt: daysAgo(2),
    },
    {
      practiceId,
      drugName: "Buprenorphine 0.3 mg/mL",
      deaSchedule: "III",
      action: "administered",
      quantity: "0.500",
      unit: "mL",
      patientId: samplePatients[1]!.id,
      performedBy: vetUsers[1]!.id,
      witnessedBy: techUsers[0]!.id,
      lotNumber: "BUP-2026-Q1-7",
      notes: "Pre-surgical analgesia",
      performedAt: daysAgo(4),
    },
    {
      practiceId,
      drugName: "Phenobarbital 30mg",
      deaSchedule: "IV",
      action: "administered",
      quantity: "30.000",
      unit: "tablet",
      patientId: samplePatients[2]!.id,
      performedBy: vetUsers[0]!.id,
      witnessedBy: techUsers[1]!.id,
      lotNumber: "PB-2026-0201",
      notes: "30-day supply dispensed for seizure control",
      performedAt: daysAgo(6),
    },
    {
      practiceId,
      drugName: "Ketamine 100 mg/mL",
      deaSchedule: "III",
      action: "administered",
      quantity: "1.200",
      unit: "mL",
      patientId: samplePatients[3]!.id,
      performedBy: vetUsers[2]!.id,
      witnessedBy: techUsers[0]!.id,
      lotNumber: "KET-2026-0405",
      notes: "Induction for spay procedure",
      performedAt: daysAgo(1),
    },
    {
      practiceId,
      drugName: "Morphine 15 mg/mL",
      deaSchedule: "II",
      action: "wasted",
      quantity: "0.200",
      unit: "mL",
      patientId: null,
      performedBy: vetUsers[0]!.id,
      witnessedBy: vetUsers[1]!.id,
      lotNumber: "MOR-2026-0112",
      notes: "Partial vial waste after dose preparation — witnessed disposal",
      performedAt: daysAgo(3),
    },
    {
      practiceId,
      drugName: "Gabapentin 100mg",
      deaSchedule: "V",
      action: "administered",
      quantity: "60.000",
      unit: "capsule",
      patientId: samplePatients[4]!.id,
      performedBy: vetUsers[1]!.id,
      witnessedBy: techUsers[1]!.id,
      lotNumber: "GAB-2026-0227",
      notes: "30-day supply for chronic pain management",
      performedAt: daysAgo(8),
    },
  ];
  const insertedCs = await db.insert(controlledSubstanceLog).values(csEntries).returning();
  console.log(`Controlled substance log: ${insertedCs.length} created`);

  // =========================================================================
  // 20. Treatment templates — common procedure bundles
  // =========================================================================
  type TemplateRow = typeof treatmentTemplates.$inferInsert;
  const templatesData: Array<TemplateRow & { items: Array<{ description: string; defaultQuantity: number; defaultUnitPrice: string }> }> = [
    {
      practiceId,
      name: "Wellness Exam — Adult Dog",
      description: "Standard annual wellness exam for adult canines. Includes physical exam, heartworm test, and fecal analysis.",
      category: "Wellness",
      isActive: true,
      items: [
        { description: "Physical examination (15 min)", defaultQuantity: 1, defaultUnitPrice: "65.00" },
        { description: "Heartworm antigen test", defaultQuantity: 1, defaultUnitPrice: "45.00" },
        { description: "Fecal flotation", defaultQuantity: 1, defaultUnitPrice: "35.00" },
      ],
    },
    {
      practiceId,
      name: "Puppy DHPP Booster Visit",
      description: "Routine puppy vaccine visit — DHPP booster with brief exam.",
      category: "Vaccination",
      isActive: true,
      items: [
        { description: "Brief exam (10 min)", defaultQuantity: 1, defaultUnitPrice: "45.00" },
        { description: "DHPP vaccine", defaultQuantity: 1, defaultUnitPrice: "32.00" },
      ],
    },
    {
      practiceId,
      name: "Dental Prophylaxis — Standard",
      description: "Routine dental cleaning under anesthesia. Includes pre-anesthetic bloodwork and scale/polish.",
      category: "Dental",
      isActive: true,
      items: [
        { description: "Pre-anesthetic bloodwork panel", defaultQuantity: 1, defaultUnitPrice: "95.00" },
        { description: "General anesthesia (first 30 min)", defaultQuantity: 1, defaultUnitPrice: "180.00" },
        { description: "Dental scale and polish", defaultQuantity: 1, defaultUnitPrice: "220.00" },
        { description: "IV fluid support", defaultQuantity: 1, defaultUnitPrice: "55.00" },
      ],
    },
    {
      practiceId,
      name: "Canine Spay — Under 40 lb",
      description: "Routine ovariohysterectomy for small/medium canines. Includes anesthesia, surgery, and 3-day pain meds.",
      category: "Surgery",
      isActive: true,
      items: [
        { description: "Pre-surgical exam & bloodwork", defaultQuantity: 1, defaultUnitPrice: "135.00" },
        { description: "Spay surgery — under 40 lb", defaultQuantity: 1, defaultUnitPrice: "385.00" },
        { description: "General anesthesia (60 min)", defaultQuantity: 1, defaultUnitPrice: "220.00" },
        { description: "Take-home pain medication (3 days)", defaultQuantity: 1, defaultUnitPrice: "28.00" },
        { description: "E-collar", defaultQuantity: 1, defaultUnitPrice: "18.00" },
      ],
    },
  ];

  for (const tpl of templatesData) {
    const { items, ...tplFields } = tpl;
    const [inserted] = await db.insert(treatmentTemplates).values(tplFields).returning();
    await db.insert(treatmentTemplateItems).values(
      items.map((item, idx) => ({
        templateId: inserted!.id,
        itemType: "service" as const,
        itemId: null,
        description: item.description,
        defaultQuantity: item.defaultQuantity,
        defaultUnitPrice: item.defaultUnitPrice,
        sortOrder: idx,
      }))
    );
  }
  console.log(`Treatment templates: ${templatesData.length} created`);

  // =========================================================================
  // Done!
  // =========================================================================
  console.log("\nSeed completed successfully!");
  console.log(`
Summary:
  - 1 practice
  - 1 location
  - ${insertedUsers.length} users (3 vets, 2 techs, 2 front desk)
  - ${insertedClients.length} clients
  - ${insertedPatients.length} patients
  - ${insertedApptTypes.length} appointment types
  - ${insertedRooms.length} exam rooms
  - ${insertedAppointments.length} appointments
  - ${soapNotesCount} SOAP notes
  - ${vaccinationValues.length} vaccination records
  - ${prescriptionValues.length} prescriptions
  - ${labResultValues.length + 1} lab results
  - ${procedureValues.length} procedures
  - ${insertedInvoices.length} invoices with ${invoiceItemValues.length} line items
  - ${insertedPayments.length} payments
  - ${insertedComms.length} communications (SMS/email/portal/phone)
  - ${insertedAudit.length} audit log entries
  - ${insertedCs.length} controlled substance log entries
  - ${templatesData.length} treatment templates
  - ${insertedServices.length} services
  - ${insertedProducts.length} products
  `);
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
