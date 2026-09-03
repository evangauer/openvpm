import { z } from "zod";
import { parseCsv, normalizeKey, normalizeRow } from "./parse";
import {
  normalizeDateValue,
  normalizePatientStatusValue,
  normalizeSexValue,
  normalizeSpeciesValue,
} from "@/lib/import/normalize";
import { SOAP_SECTION_MAX_LENGTH } from "@/lib/records/soap-content";

/**
 * Map parsed CSV rows into the record shapes the data router's import
 * mutations expect. Header matching is normalized (case/spacing/underscore
 * insensitive) and each field accepts the aliases that real PIMS exports
 * use (AVImark, Cornerstone, ezyVet, plain spreadsheets), so a clinic's
 * export usually imports without hand-editing headers. Returns valid
 * records plus per-row errors so a partial import can proceed and report
 * what it skipped. Pure — no I/O.
 */

export interface ClientImportRecord {
  externalClientId?: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface PatientImportRecord {
  clientEmail?: string;
  externalClientId?: string;
  externalPatientId?: string;
  name: string;
  species:
    | "canine"
    | "feline"
    | "avian"
    | "rabbit"
    | "reptile"
    | "equine"
    | "bovine"
    | "ovine"
    | "caprine"
    | "porcine"
    | "poultry"
    | "camelid"
    | "other";
  breed?: string;
  sex?: "male" | "female" | "male_neutered" | "female_spayed";
  dob?: string;
  color?: string;
  microchipNumber?: string;
  status?: "active" | "inactive" | "deceased";
}

export interface VaccinationImportRecord {
  clientEmail?: string;
  externalClientId?: string;
  externalPatientId?: string;
  patientName?: string;
  vaccineName: string;
  administeredAt: string;
  nextDueDate?: string;
  lotNumber?: string;
  manufacturer?: string;
}

export interface SoapNoteImportRecord {
  clientEmail?: string;
  externalClientId?: string;
  externalPatientId?: string;
  patientName?: string;
  /** Visit date (YYYY-MM-DD). Preserved onto the record so the medical
   * history timeline reads in true chronological order after a migration. */
  date: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

export interface CareReminderImportRecord {
  externalReminderId: string;
  clientEmail?: string;
  externalClientId?: string;
  externalPatientId?: string;
  patientName?: string;
  title: string;
  dueDate: string;
  notes?: string;
}

export interface ServiceImportRecord {
  externalServiceId: string;
  name: string;
  code?: string;
  category?: string;
  defaultPrice: string;
  taxable: boolean;
}

export interface ParseResult<T> {
  records: T[];
  errors: string[];
}

const SPECIES = [
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "bovine",
  "ovine",
  "caprine",
  "porcine",
  "poultry",
  "camelid",
  "other",
];

/**
 * Normalized-header aliases per field (see parse.ts normalizeKey: lowercase,
 * strip non-alphanumerics). First match wins, so put our canonical export
 * headers first — a round-trip of our own export must always import.
 */
const CLIENT_ALIASES: Record<keyof ClientImportRecord, string[]> = {
  externalClientId: [
    "clientid",
    "ownerid",
    "accountid",
    "clientnumber",
    "ownernumber",
    "accountnumber",
  ],
  firstName: [
    "firstname",
    "first",
    "clientfirstname",
    "ownerfirstname",
    "fname",
    "givenname",
  ],
  lastName: [
    "lastname",
    "last",
    "surname",
    "clientlastname",
    "ownerlastname",
    "lname",
    "familyname",
  ],
  email: ["email", "emailaddress", "clientemail", "owneremail", "email1"],
  phone: [
    "phone",
    "phonenumber",
    "homephone",
    "cellphone",
    "mobilephone",
    "mobile",
    "phone1",
    "contactnumber",
  ],
  address: ["address", "address1", "streetaddress", "addressline1", "street"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "postalcode", "postcode"],
};

const PATIENT_ALIASES: Record<keyof PatientImportRecord, string[]> = {
  externalClientId: [
    "clientid",
    "ownerid",
    "accountid",
    "clientnumber",
    "ownernumber",
    "accountnumber",
  ],
  externalPatientId: [
    "patientid",
    "petid",
    "animalid",
    "patientnumber",
    "petnumber",
    "animalnumber",
  ],
  clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
  name: ["name", "patientname", "petname", "patient", "pet", "animalname"],
  species: ["species", "speciesdescription", "kind", "animaltype"],
  breed: ["breed", "breeddescription"],
  sex: ["sex", "gender"],
  dob: ["dob", "dateofbirth", "birthday", "birthdate", "born"],
  color: ["color", "colour", "markings"],
  microchipNumber: [
    "microchipnumber",
    "microchip",
    "chipnumber",
    "microchipid",
    "chipid",
  ],
  status: ["status", "patientstatus", "chartstatus", "animalstatus"],
};

const VACCINATION_ALIASES: Record<keyof VaccinationImportRecord, string[]> = {
  externalClientId: [
    "clientid",
    "ownerid",
    "accountid",
    "clientnumber",
    "ownernumber",
    "accountnumber",
  ],
  externalPatientId: [
    "patientid",
    "petid",
    "animalid",
    "patientnumber",
    "petnumber",
    "animalnumber",
  ],
  clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
  patientName: [
    "patientname",
    "name",
    "petname",
    "patient",
    "pet",
    "animalname",
  ],
  vaccineName: [
    "vaccinename",
    "vaccine",
    "vaccination",
    "description",
    "treatment",
  ],
  administeredAt: [
    "administeredat",
    "dategiven",
    "givendate",
    "givenon",
    "date",
    "vaccinationdate",
    "administered",
    "dateadministered",
  ],
  nextDueDate: [
    "nextduedate",
    "duedate",
    "nextdue",
    "due",
    "dueon",
    "expires",
    "expirationdate",
  ],
  lotNumber: ["lotnumber", "lot", "serialnumber", "serial"],
  manufacturer: ["manufacturer", "maker", "brand", "producer"],
};

/**
 * Medical history (visit notes) → SOAP notes. `note` is the generic
 * free-text fallback: exports that keep a single visit note in one column
 * (not split into S/O/A/P) land it in the Subjective section. Explicit
 * subjective/objective/assessment/plan columns always win when present.
 */
const SOAP_NOTE_ALIASES: Record<keyof SoapNoteImportRecord | "note", string[]> =
  {
    externalClientId: [
      "clientid",
      "ownerid",
      "accountid",
      "clientnumber",
      "ownernumber",
      "accountnumber",
    ],
    externalPatientId: [
      "patientid",
      "petid",
      "animalid",
      "patientnumber",
      "petnumber",
      "animalnumber",
    ],
    clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
    patientName: [
      "patientname",
      "name",
      "petname",
      "patient",
      "pet",
      "animalname",
    ],
    date: [
      "date",
      "visitdate",
      "dateofservice",
      "servicedate",
      "serviceddate",
      "examdate",
      "recorddate",
      "recordeddate",
      "dateofvisit",
      "encounterdate",
      "dateseen",
    ],
    subjective: [
      "subjective",
      "history",
      "presentingcomplaint",
      "chiefcomplaint",
      "reasonforvisit",
      "complaint",
    ],
    objective: [
      "objective",
      "examfindings",
      "physicalexam",
      "findings",
      "examination",
    ],
    assessment: ["assessment", "diagnosis", "impression", "dx"],
    plan: [
      "plan",
      "treatmentplan",
      "treatment",
      "recommendations",
      "planofcare",
    ],
    note: [
      "note",
      "notes",
      "medicalnotes",
      "visitnotes",
      "soapnote",
      "soap",
      "chartnote",
      "clinicalnotes",
      "progressnote",
      "recordtext",
      "summary",
      "description",
    ],
  };

const CARE_REMINDER_ALIASES: Record<keyof CareReminderImportRecord, string[]> =
  {
    externalReminderId: [
      "reminderid",
      "externalreminderid",
      "taskid",
      "followupid",
      "id",
    ],
    externalClientId: [
      "clientid",
      "ownerid",
      "accountid",
      "clientnumber",
      "ownernumber",
      "accountnumber",
    ],
    externalPatientId: [
      "patientid",
      "petid",
      "animalid",
      "patientnumber",
      "petnumber",
      "animalnumber",
    ],
    clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
    patientName: [
      "patientname",
      "name",
      "petname",
      "patient",
      "pet",
      "animalname",
    ],
    title: [
      "title",
      "reminder",
      "remindername",
      "task",
      "followup",
      "description",
    ],
    dueDate: ["duedate", "datedue", "due", "dueon", "followupdate"],
    notes: ["notes", "note", "instructions", "details"],
  };

const SERVICE_ALIASES: Record<keyof ServiceImportRecord, string[]> = {
  externalServiceId: [
    "serviceid",
    "externalserviceid",
    "productid",
    "itemid",
    "id",
  ],
  name: ["name", "servicename", "itemname", "description"],
  code: ["code", "servicecode", "itemcode", "customid", "sku"],
  category: ["category", "servicecategory", "productcategory"],
  defaultPrice: ["defaultprice", "price", "unitprice", "serviceprice"],
  taxable: ["taxable", "istaxable", "taxed", "applytax"],
};

/** SOAP sections in the order a standalone notes column fills empty ones. */
const SOAP_SECTION_KEYS = [
  "subjective",
  "objective",
  "assessment",
  "plan",
] as const;
const SOAP_PATIENT_NAME_MAX = 128;
const EXTERNAL_ID_MAX = 160;
// Mirrors the router's per-field validation so a single bad cell is reported
// as a per-row issue (and skipped) instead of the stricter server layer
// rejecting the whole file and blocking the dry run.
const importEmailCheck = z.string().trim().email().max(255);

interface RequiredCsvColumn {
  label: string;
  aliases: string[];
  examples: string;
}

const EXTERNAL_CLIENT_ID_ALIASES = [
  "clientid",
  "ownerid",
  "accountid",
  "clientnumber",
  "ownernumber",
  "accountnumber",
];
const EXTERNAL_PATIENT_ID_ALIASES = [
  "patientid",
  "petid",
  "animalid",
  "patientnumber",
  "petnumber",
  "animalnumber",
];

function hasHeader(headers: string[], aliases: string[]): boolean {
  const normalized = new Set(headers.map(normalizeKey));
  return aliases.some((alias) => normalized.has(alias));
}

function preflightCsvHeaders(
  headers: string[],
  rows: Record<string, string>[],
  required: RequiredCsvColumn[],
  options?: {
    contentColumns?: RequiredCsvColumn;
  },
): string[] {
  if (headers.length === 0) {
    return ["CSV is empty or is missing a header row."];
  }

  if (rows.length === 0) {
    return ["CSV has a header row but no data rows."];
  }

  const errors: string[] = [];
  for (const column of required) {
    if (hasHeader(headers, column.aliases)) continue;

    errors.push(
      `CSV is missing a recognized ${column.label} column. Add one of: ${column.examples}.`,
    );
  }

  if (
    options?.contentColumns &&
    !hasHeader(headers, options.contentColumns.aliases)
  ) {
    errors.push(
      `CSV is missing a recognized ${options.contentColumns.label} column. Add one of: ${options.contentColumns.examples}.`,
    );
  }

  return errors;
}

function ownerReferencePreflight(headers: string[]): string[] {
  if (
    hasHeader(headers, PATIENT_ALIASES.clientEmail) ||
    hasHeader(headers, EXTERNAL_CLIENT_ID_ALIASES)
  ) {
    return [];
  }

  return [
    "CSV is missing a recognized owner reference column. Add Owner Email, Client Email, Client ID, Owner ID, or Account ID.",
  ];
}

function patientReferencePreflight(headers: string[]): string[] {
  if (hasHeader(headers, EXTERNAL_PATIENT_ID_ALIASES)) return [];

  const errors = ownerReferencePreflight(headers);
  if (!hasHeader(headers, PATIENT_ALIASES.name)) {
    errors.push(
      "CSV is missing a recognized patient reference column. Add Patient ID, Patient Name, Pet Name, or Animal Name.",
    );
  }
  return errors;
}

function opt(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function normalizeImportMoney(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || !/^\d+(?:\.\d{1,2})?$/.test(raw)) return undefined;
  const [whole, fraction = ""] = raw.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > 9_999_999_999n) return undefined;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function normalizeImportBoolean(
  value: string | undefined,
): boolean | undefined {
  const raw = value?.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(raw ?? "")) return true;
  if (["false", "no", "n", "0"].includes(raw ?? "")) return false;
  return undefined;
}

/** First non-empty value among a field's normalized-header aliases. */
function fromAliases(
  row: Record<string, string>,
  aliases: string[],
): string | undefined {
  for (const key of aliases) {
    const value = opt(row[key]);
    if (value) return value;
  }
  return undefined;
}

export function csvToClientRecords(
  csv: string,
): ParseResult<ClientImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: ClientImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  const preflightErrors = preflightCsvHeaders(headers, rows, [
    {
      label: "client first-name",
      aliases: CLIENT_ALIASES.firstName,
      examples: "First Name, Client First Name, or Given Name",
    },
    {
      label: "client last-name",
      aliases: CLIENT_ALIASES.lastName,
      examples: "Last Name, Client Last Name, or Surname",
    },
  ]);
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const externalClientId = fromAliases(r, CLIENT_ALIASES.externalClientId);
    const firstName = fromAliases(r, CLIENT_ALIASES.firstName);
    const lastName = fromAliases(r, CLIENT_ALIASES.lastName);
    const email = fromAliases(r, CLIENT_ALIASES.email);
    if (!firstName || !lastName) {
      errors.push(`Row ${i + 1}: firstName and lastName are required.`);
      return;
    }
    if (!email && !externalClientId) {
      errors.push(
        `Row ${i + 1}: an email or external client ID is required for safe repeat imports.`,
      );
      return;
    }
    if (email && !importEmailCheck.safeParse(email).success) {
      errors.push(`Row ${i + 1}: email is not a valid email address.`);
      return;
    }
    if ((externalClientId?.length ?? 0) > EXTERNAL_ID_MAX) {
      errors.push(`Row ${i + 1}: external client ID is too long.`);
      return;
    }
    records.push({
      externalClientId,
      firstName,
      lastName,
      email,
      phone: fromAliases(r, CLIENT_ALIASES.phone),
      address: fromAliases(r, CLIENT_ALIASES.address),
      city: fromAliases(r, CLIENT_ALIASES.city),
      state: fromAliases(r, CLIENT_ALIASES.state),
      zip: fromAliases(r, CLIENT_ALIASES.zip),
    });
  });

  return { records, errors };
}

export function csvToPatientRecords(
  csv: string,
): ParseResult<PatientImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: PatientImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  const preflightErrors = [
    ...ownerReferencePreflight(headers),
    ...preflightCsvHeaders(headers, rows, [
      {
        label: "patient name",
        aliases: PATIENT_ALIASES.name,
        examples: "Patient Name, Pet Name, or Animal Name",
      },
      {
        label: "species",
        aliases: PATIENT_ALIASES.species,
        examples: "Species or Animal Type",
      },
    ]),
  ];
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, PATIENT_ALIASES.clientEmail);
    const externalClientId = fromAliases(r, PATIENT_ALIASES.externalClientId);
    const externalPatientId = fromAliases(r, PATIENT_ALIASES.externalPatientId);
    const name = fromAliases(r, PATIENT_ALIASES.name);
    const speciesRaw = fromAliases(r, PATIENT_ALIASES.species);
    const species = normalizeSpeciesValue(speciesRaw);

    if (!clientEmail && !externalClientId) {
      errors.push(`Row ${i + 1}: an owner email or owner ID is required.`);
      return;
    }
    if (clientEmail && !importEmailCheck.safeParse(clientEmail).success) {
      errors.push(`Row ${i + 1}: owner email is not a valid email address.`);
      return;
    }
    if (
      (externalClientId?.length ?? 0) > EXTERNAL_ID_MAX ||
      (externalPatientId?.length ?? 0) > EXTERNAL_ID_MAX
    ) {
      errors.push(`Row ${i + 1}: an external ID is too long.`);
      return;
    }
    if (!name) {
      errors.push(`Row ${i + 1}: name is required.`);
      return;
    }
    if (!species) {
      errors.push(
        `Row ${i + 1}: species must be one of ${SPECIES.join(", ")} (got "${speciesRaw?.toLowerCase() ?? ""}").`,
      );
      return;
    }

    // DOB: normalize common formats; an unreadable value passes through so
    // the router's validation reports it with the exact expected format.
    const dobRaw = fromAliases(r, PATIENT_ALIASES.dob);
    const dob = dobRaw ? (normalizeDateValue(dobRaw) ?? dobRaw) : undefined;
    const statusRaw = fromAliases(r, PATIENT_ALIASES.status);
    const status = normalizePatientStatusValue(statusRaw);
    if (statusRaw && !status) {
      errors.push(
        `Row ${i + 1}: patient status must be active, inactive, or deceased.`,
      );
      return;
    }

    records.push({
      clientEmail,
      externalClientId,
      externalPatientId,
      name,
      species,
      breed: fromAliases(r, PATIENT_ALIASES.breed),
      sex: normalizeSexValue(fromAliases(r, PATIENT_ALIASES.sex)),
      dob,
      color: fromAliases(r, PATIENT_ALIASES.color),
      microchipNumber: fromAliases(r, PATIENT_ALIASES.microchipNumber),
      ...(status ? { status } : {}),
    });
  });

  return { records, errors };
}

export function csvToVaccinationRecords(
  csv: string,
): ParseResult<VaccinationImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: VaccinationImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  const preflightErrors = [
    ...patientReferencePreflight(headers),
    ...preflightCsvHeaders(headers, rows, [
      {
        label: "vaccine name",
        aliases: VACCINATION_ALIASES.vaccineName,
        examples: "Vaccine Name, Vaccine, or Vaccination",
      },
      {
        label: "administered date",
        aliases: VACCINATION_ALIASES.administeredAt,
        examples: "Date Given, Vaccination Date, or Date Administered",
      },
    ]),
  ];
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, VACCINATION_ALIASES.clientEmail);
    const externalClientId = fromAliases(
      r,
      VACCINATION_ALIASES.externalClientId,
    );
    const externalPatientId = fromAliases(
      r,
      VACCINATION_ALIASES.externalPatientId,
    );
    const patientName = fromAliases(r, VACCINATION_ALIASES.patientName);
    const vaccineName = fromAliases(r, VACCINATION_ALIASES.vaccineName);
    const administeredRaw = fromAliases(r, VACCINATION_ALIASES.administeredAt);

    if (!externalPatientId && !clientEmail && !externalClientId) {
      errors.push(
        `Row ${i + 1}: a patient ID or owner reference is required to link the vaccine.`,
      );
      return;
    }
    if (!externalPatientId && !patientName) {
      errors.push(`Row ${i + 1}: patientName is required.`);
      return;
    }
    if (clientEmail && !importEmailCheck.safeParse(clientEmail).success) {
      errors.push(`Row ${i + 1}: owner email is not a valid email address.`);
      return;
    }
    if (
      (externalClientId?.length ?? 0) > EXTERNAL_ID_MAX ||
      (externalPatientId?.length ?? 0) > EXTERNAL_ID_MAX
    ) {
      errors.push(`Row ${i + 1}: an external ID is too long.`);
      return;
    }
    if (!vaccineName) {
      errors.push(`Row ${i + 1}: vaccineName is required.`);
      return;
    }
    const administeredAt = normalizeDateValue(administeredRaw);
    if (!administeredAt) {
      errors.push(
        `Row ${i + 1}: dateGiven must be a date (like 2025-10-04 or 10/4/2025), got "${administeredRaw ?? ""}".`,
      );
      return;
    }

    const dueRaw = fromAliases(r, VACCINATION_ALIASES.nextDueDate);
    const nextDueDate = dueRaw
      ? (normalizeDateValue(dueRaw) ?? undefined)
      : undefined;
    if (dueRaw && !nextDueDate) {
      errors.push(
        `Row ${i + 1}: nextDueDate could not be read as a date (got "${dueRaw}"); the row imports without it.`,
      );
    }

    records.push({
      clientEmail,
      externalClientId,
      externalPatientId,
      patientName,
      vaccineName,
      administeredAt,
      nextDueDate,
      lotNumber: fromAliases(r, VACCINATION_ALIASES.lotNumber),
      manufacturer: fromAliases(r, VACCINATION_ALIASES.manufacturer),
    });
  });

  return { records, errors };
}

/**
 * Medical history import (migration): each row is one dated visit note for a
 * pet, mapped to a SOAP note. Rows prefer a persisted external patient ID and
 * fall back to an owner reference + pet name, so run this after clients and
 * patients. A row needs a readable date and at least one note section.
 */
export function csvToSoapNoteRecords(
  csv: string,
): ParseResult<SoapNoteImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: SoapNoteImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  const noteAliases = [
    ...SOAP_NOTE_ALIASES.subjective,
    ...SOAP_NOTE_ALIASES.objective,
    ...SOAP_NOTE_ALIASES.assessment,
    ...SOAP_NOTE_ALIASES.plan,
    ...SOAP_NOTE_ALIASES.note,
  ];
  const preflightErrors = [
    ...patientReferencePreflight(headers),
    ...preflightCsvHeaders(
      headers,
      rows,
      [
        {
          label: "visit date",
          aliases: SOAP_NOTE_ALIASES.date,
          examples: "Visit Date, Date of Service, or Encounter Date",
        },
      ],
      {
        contentColumns: {
          label: "medical-note content",
          aliases: noteAliases,
          examples: "Notes, Subjective, Objective, Assessment, or Plan",
        },
      },
    ),
  ];
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, SOAP_NOTE_ALIASES.clientEmail);
    const externalClientId = fromAliases(r, SOAP_NOTE_ALIASES.externalClientId);
    const externalPatientId = fromAliases(
      r,
      SOAP_NOTE_ALIASES.externalPatientId,
    );
    const patientName = fromAliases(r, SOAP_NOTE_ALIASES.patientName);
    const dateRaw = fromAliases(r, SOAP_NOTE_ALIASES.date);

    if (!externalPatientId && !clientEmail && !externalClientId) {
      errors.push(
        `Row ${i + 1}: a patient ID or owner reference is required to link the note.`,
      );
      return;
    }
    if (!externalPatientId && !patientName) {
      errors.push(`Row ${i + 1}: patientName is required.`);
      return;
    }
    // Validate the email + lengths here (not only "is it present") so one
    // malformed cell reports a per-row issue and is skipped, instead of the
    // stricter server layer rejecting the whole file and blocking the dry run.
    if (clientEmail && !importEmailCheck.safeParse(clientEmail).success) {
      errors.push(`Row ${i + 1}: clientEmail is not a valid email address.`);
      return;
    }
    if (
      (externalClientId?.length ?? 0) > EXTERNAL_ID_MAX ||
      (externalPatientId?.length ?? 0) > EXTERNAL_ID_MAX
    ) {
      errors.push(`Row ${i + 1}: an external ID is too long.`);
      return;
    }
    if (patientName && patientName.length > SOAP_PATIENT_NAME_MAX) {
      errors.push(
        `Row ${i + 1}: patientName is too long (max ${SOAP_PATIENT_NAME_MAX} characters).`,
      );
      return;
    }
    const date = normalizeDateValue(dateRaw);
    if (!date) {
      errors.push(
        `Row ${i + 1}: date must be a date (like 2025-10-04 or 10/4/2025), got "${dateRaw ?? ""}".`,
      );
      return;
    }

    // Map explicit SOAP columns, then drop any standalone notes column into
    // the first still-empty section, so a free-text notes column is never
    // silently discarded when a Subjective-family column is also present.
    const sections: Record<
      (typeof SOAP_SECTION_KEYS)[number],
      string | undefined
    > = {
      subjective: fromAliases(r, SOAP_NOTE_ALIASES.subjective),
      objective: fromAliases(r, SOAP_NOTE_ALIASES.objective),
      assessment: fromAliases(r, SOAP_NOTE_ALIASES.assessment),
      plan: fromAliases(r, SOAP_NOTE_ALIASES.plan),
    };
    const note = fromAliases(r, SOAP_NOTE_ALIASES.note);
    if (note) {
      const firstEmpty = SOAP_SECTION_KEYS.find((key) => !sections[key]);
      if (firstEmpty) {
        sections[firstEmpty] = note;
      } else {
        sections.plan = `${sections.plan}\n\n${note}`;
      }
    }

    if (
      !sections.subjective &&
      !sections.objective &&
      !sections.assessment &&
      !sections.plan
    ) {
      errors.push(
        `Row ${i + 1}: needs at least one note (Subjective, Objective, Assessment, Plan, or a Notes column).`,
      );
      return;
    }

    const tooLong = SOAP_SECTION_KEYS.find(
      (key) => (sections[key]?.length ?? 0) > SOAP_SECTION_MAX_LENGTH,
    );
    if (tooLong) {
      errors.push(
        `Row ${i + 1}: ${tooLong} note is too long (max ${SOAP_SECTION_MAX_LENGTH} characters); split it into a shorter note.`,
      );
      return;
    }

    records.push({
      clientEmail,
      externalClientId,
      externalPatientId,
      patientName,
      date,
      subjective: sections.subjective,
      objective: sections.objective,
      assessment: sections.assessment,
      plan: sections.plan,
    });
  });

  return { records, errors };
}

/**
 * Internal care-task import. Creating these rows never schedules or sends a
 * client communication; staff review and complete them inside OpenVPM.
 */
export function csvToCareReminderRecords(
  csv: string,
): ParseResult<CareReminderImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: CareReminderImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) return { records, errors };

  const preflightErrors = [
    ...patientReferencePreflight(headers),
    ...preflightCsvHeaders(headers, rows, [
      {
        label: "reminder ID",
        aliases: CARE_REMINDER_ALIASES.externalReminderId,
        examples: "Reminder ID, Task ID, Follow-up ID, or ID",
      },
      {
        label: "reminder title",
        aliases: CARE_REMINDER_ALIASES.title,
        examples: "Title, Reminder, Task, or Description",
      },
      {
        label: "reminder due date",
        aliases: CARE_REMINDER_ALIASES.dueDate,
        examples: "Due Date, Date Due, or Follow-up Date",
      },
    ]),
  ];
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, index) => {
    const row = normalizeRow(raw);
    const externalReminderId = fromAliases(
      row,
      CARE_REMINDER_ALIASES.externalReminderId,
    );
    const externalPatientId = fromAliases(
      row,
      CARE_REMINDER_ALIASES.externalPatientId,
    );
    const externalClientId = fromAliases(
      row,
      CARE_REMINDER_ALIASES.externalClientId,
    );
    const clientEmail = fromAliases(row, CARE_REMINDER_ALIASES.clientEmail);
    const patientName = fromAliases(row, CARE_REMINDER_ALIASES.patientName);
    const title = fromAliases(row, CARE_REMINDER_ALIASES.title);
    const dueRaw = fromAliases(row, CARE_REMINDER_ALIASES.dueDate);
    const dueDate = normalizeDateValue(dueRaw);
    const notes = fromAliases(row, CARE_REMINDER_ALIASES.notes);

    if (!externalReminderId) {
      errors.push(`Row ${index + 1}: an external reminder ID is required.`);
      return;
    }
    if (externalReminderId.length > EXTERNAL_ID_MAX) {
      errors.push(`Row ${index + 1}: external reminder ID is too long.`);
      return;
    }
    if (!externalPatientId && !clientEmail && !externalClientId) {
      errors.push(
        `Row ${index + 1}: a patient ID or owner reference is required to link the reminder.`,
      );
      return;
    }
    if (!externalPatientId && !patientName) {
      errors.push(`Row ${index + 1}: patientName is required.`);
      return;
    }
    if (clientEmail && !importEmailCheck.safeParse(clientEmail).success) {
      errors.push(
        `Row ${index + 1}: owner email is not a valid email address.`,
      );
      return;
    }
    if (
      (externalClientId?.length ?? 0) > EXTERNAL_ID_MAX ||
      (externalPatientId?.length ?? 0) > EXTERNAL_ID_MAX
    ) {
      errors.push(`Row ${index + 1}: an external ID is too long.`);
      return;
    }
    if (!title) {
      errors.push(`Row ${index + 1}: reminder title is required.`);
      return;
    }
    if (title.length > 255) {
      errors.push(`Row ${index + 1}: reminder title is too long.`);
      return;
    }
    if (!dueDate) {
      errors.push(`Row ${index + 1}: due date could not be read as a date.`);
      return;
    }
    if ((notes?.length ?? 0) > 4000) {
      errors.push(`Row ${index + 1}: reminder notes are too long.`);
      return;
    }

    records.push({
      externalReminderId,
      externalPatientId,
      externalClientId,
      clientEmail,
      patientName,
      title,
      dueDate,
      notes,
    });
  });

  return { records, errors };
}

/** Generic service-catalog import. Inventory products use a separate safety
 * contract because charging them can change stock. */
export function csvToServiceRecords(
  csv: string,
): ParseResult<ServiceImportRecord> {
  const { headers, rows, errors: parseErrors } = parseCsv(csv);
  const records: ServiceImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) return { records, errors };
  const preflightErrors = preflightCsvHeaders(headers, rows, [
    {
      label: "service ID",
      aliases: SERVICE_ALIASES.externalServiceId,
      examples: "Service ID, Product ID, Item ID, or ID",
    },
    {
      label: "service name",
      aliases: SERVICE_ALIASES.name,
      examples: "Name, Service Name, Item Name, or Description",
    },
    {
      label: "default price",
      aliases: SERVICE_ALIASES.defaultPrice,
      examples: "Default Price, Price, Unit Price, or Service Price",
    },
    {
      label: "taxable status",
      aliases: SERVICE_ALIASES.taxable,
      examples: "Taxable, Is Taxable, or Apply Tax",
    },
  ]);
  if (preflightErrors.length > 0) {
    return { records, errors: preflightErrors };
  }

  rows.forEach((raw, index) => {
    const row = normalizeRow(raw);
    const externalServiceId = fromAliases(
      row,
      SERVICE_ALIASES.externalServiceId,
    );
    const name = fromAliases(row, SERVICE_ALIASES.name);
    const code = fromAliases(row, SERVICE_ALIASES.code);
    const category = fromAliases(row, SERVICE_ALIASES.category);
    const defaultPrice = normalizeImportMoney(
      fromAliases(row, SERVICE_ALIASES.defaultPrice),
    );
    const taxable = normalizeImportBoolean(
      fromAliases(row, SERVICE_ALIASES.taxable),
    );

    if (!externalServiceId || externalServiceId.length > EXTERNAL_ID_MAX) {
      errors.push(`Row ${index + 1}: a valid external service ID is required.`);
      return;
    }
    if (!name || name.length > 255) {
      errors.push(`Row ${index + 1}: a valid service name is required.`);
      return;
    }
    if ((code?.length ?? 0) > 32) {
      errors.push(`Row ${index + 1}: service code is too long.`);
      return;
    }
    if ((category?.length ?? 0) > 128) {
      errors.push(`Row ${index + 1}: service category is too long.`);
      return;
    }
    if (!defaultPrice) {
      errors.push(
        `Row ${index + 1}: default price must be a non-negative currency amount.`,
      );
      return;
    }
    if (taxable === undefined) {
      errors.push(`Row ${index + 1}: taxable status must be true or false.`);
      return;
    }

    records.push({
      externalServiceId,
      name,
      code,
      category,
      defaultPrice,
      taxable,
    });
  });

  return { records, errors };
}
