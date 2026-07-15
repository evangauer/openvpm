import { parseCsv, normalizeRow } from "./parse";
import {
  normalizeDateValue,
  normalizeSexValue,
  normalizeSpeciesValue,
} from "@/lib/import/normalize";

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
  clientEmail: string;
  name: string;
  species: "canine" | "feline" | "avian" | "rabbit" | "reptile" | "equine" | "other";
  breed?: string;
  sex?: "male" | "female" | "male_neutered" | "female_spayed";
  dob?: string;
  color?: string;
  microchipNumber?: string;
}

export interface VaccinationImportRecord {
  clientEmail: string;
  patientName: string;
  vaccineName: string;
  administeredAt: string;
  nextDueDate?: string;
  lotNumber?: string;
  manufacturer?: string;
}

export interface SoapNoteImportRecord {
  clientEmail: string;
  patientName: string;
  /** Visit date (YYYY-MM-DD). Preserved onto the record so the medical
   * history timeline reads in true chronological order after a migration. */
  date: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

export interface ParseResult<T> {
  records: T[];
  errors: string[];
}

const SPECIES = ["canine", "feline", "avian", "rabbit", "reptile", "equine", "other"];

/**
 * Normalized-header aliases per field (see parse.ts normalizeKey: lowercase,
 * strip non-alphanumerics). First match wins, so put our canonical export
 * headers first — a round-trip of our own export must always import.
 */
const CLIENT_ALIASES: Record<keyof ClientImportRecord, string[]> = {
  firstName: ["firstname", "first", "clientfirstname", "ownerfirstname", "fname", "givenname"],
  lastName: ["lastname", "last", "surname", "clientlastname", "ownerlastname", "lname", "familyname"],
  email: ["email", "emailaddress", "clientemail", "owneremail", "email1"],
  phone: ["phone", "phonenumber", "homephone", "cellphone", "mobilephone", "mobile", "phone1", "contactnumber"],
  address: ["address", "address1", "streetaddress", "addressline1", "street"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "postalcode", "postcode"],
};

const PATIENT_ALIASES: Record<keyof PatientImportRecord, string[]> = {
  clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
  name: ["name", "patientname", "petname", "patient", "pet", "animalname"],
  species: ["species", "speciesdescription", "kind", "animaltype"],
  breed: ["breed", "breeddescription"],
  sex: ["sex", "gender"],
  dob: ["dob", "dateofbirth", "birthday", "birthdate", "born"],
  color: ["color", "colour", "markings"],
  microchipNumber: ["microchipnumber", "microchip", "chipnumber", "microchipid", "chipid"],
};

const VACCINATION_ALIASES: Record<keyof VaccinationImportRecord, string[]> = {
  clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
  patientName: ["patientname", "name", "petname", "patient", "pet", "animalname"],
  vaccineName: ["vaccinename", "vaccine", "vaccination", "description", "treatment"],
  administeredAt: ["administeredat", "dategiven", "givendate", "givenon", "date", "vaccinationdate", "administered", "dateadministered"],
  nextDueDate: ["nextduedate", "duedate", "nextdue", "due", "dueon", "expires", "expirationdate"],
  lotNumber: ["lotnumber", "lot", "serialnumber", "serial"],
  manufacturer: ["manufacturer", "maker", "brand", "producer"],
};

/**
 * Medical history (visit notes) → SOAP notes. `note` is the generic
 * free-text fallback: exports that keep a single visit note in one column
 * (not split into S/O/A/P) land it in the Subjective section. Explicit
 * subjective/objective/assessment/plan columns always win when present.
 */
const SOAP_NOTE_ALIASES: Record<
  keyof SoapNoteImportRecord | "note",
  string[]
> = {
  clientEmail: ["clientemail", "owneremail", "email", "emailaddress"],
  patientName: ["patientname", "name", "petname", "patient", "pet", "animalname"],
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
  subjective: ["subjective", "history", "presentingcomplaint", "chiefcomplaint", "reasonforvisit", "complaint"],
  objective: ["objective", "examfindings", "physicalexam", "findings", "examination"],
  assessment: ["assessment", "diagnosis", "impression", "dx"],
  plan: ["plan", "treatmentplan", "treatment", "recommendations", "planofcare"],
  note: ["note", "notes", "medicalnotes", "visitnotes", "soapnote", "soap", "chartnote", "clinicalnotes", "progressnote", "recordtext", "summary", "description"],
};

function opt(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** First non-empty value among a field's normalized-header aliases. */
function fromAliases(
  row: Record<string, string>,
  aliases: string[]
): string | undefined {
  for (const key of aliases) {
    const value = opt(row[key]);
    if (value) return value;
  }
  return undefined;
}

export function csvToClientRecords(csv: string): ParseResult<ClientImportRecord> {
  const { rows, errors: parseErrors } = parseCsv(csv);
  const records: ClientImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const firstName = fromAliases(r, CLIENT_ALIASES.firstName);
    const lastName = fromAliases(r, CLIENT_ALIASES.lastName);
    if (!firstName || !lastName) {
      errors.push(`Row ${i + 1}: firstName and lastName are required.`);
      return;
    }
    records.push({
      firstName,
      lastName,
      email: fromAliases(r, CLIENT_ALIASES.email),
      phone: fromAliases(r, CLIENT_ALIASES.phone),
      address: fromAliases(r, CLIENT_ALIASES.address),
      city: fromAliases(r, CLIENT_ALIASES.city),
      state: fromAliases(r, CLIENT_ALIASES.state),
      zip: fromAliases(r, CLIENT_ALIASES.zip),
    });
  });

  return { records, errors };
}

export function csvToPatientRecords(csv: string): ParseResult<PatientImportRecord> {
  const { rows, errors: parseErrors } = parseCsv(csv);
  const records: PatientImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, PATIENT_ALIASES.clientEmail);
    const name = fromAliases(r, PATIENT_ALIASES.name);
    const speciesRaw = fromAliases(r, PATIENT_ALIASES.species);
    const species = normalizeSpeciesValue(speciesRaw);

    if (!clientEmail) {
      errors.push(`Row ${i + 1}: clientEmail is required to link the pet to an owner.`);
      return;
    }
    if (!name) {
      errors.push(`Row ${i + 1}: name is required.`);
      return;
    }
    if (!species) {
      errors.push(
        `Row ${i + 1}: species must be one of ${SPECIES.join(", ")} (got "${speciesRaw?.toLowerCase() ?? ""}").`
      );
      return;
    }

    // DOB: normalize common formats; an unreadable value passes through so
    // the router's validation reports it with the exact expected format.
    const dobRaw = fromAliases(r, PATIENT_ALIASES.dob);
    const dob = dobRaw ? normalizeDateValue(dobRaw) ?? dobRaw : undefined;

    records.push({
      clientEmail,
      name,
      species,
      breed: fromAliases(r, PATIENT_ALIASES.breed),
      sex: normalizeSexValue(fromAliases(r, PATIENT_ALIASES.sex)),
      dob,
      color: fromAliases(r, PATIENT_ALIASES.color),
      microchipNumber: fromAliases(r, PATIENT_ALIASES.microchipNumber),
    });
  });

  return { records, errors };
}

export function csvToVaccinationRecords(
  csv: string
): ParseResult<VaccinationImportRecord> {
  const { rows, errors: parseErrors } = parseCsv(csv);
  const records: VaccinationImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, VACCINATION_ALIASES.clientEmail);
    const patientName = fromAliases(r, VACCINATION_ALIASES.patientName);
    const vaccineName = fromAliases(r, VACCINATION_ALIASES.vaccineName);
    const administeredRaw = fromAliases(r, VACCINATION_ALIASES.administeredAt);

    if (!clientEmail) {
      errors.push(
        `Row ${i + 1}: clientEmail is required to link the vaccine to a pet.`
      );
      return;
    }
    if (!patientName) {
      errors.push(`Row ${i + 1}: patientName is required.`);
      return;
    }
    if (!vaccineName) {
      errors.push(`Row ${i + 1}: vaccineName is required.`);
      return;
    }
    const administeredAt = normalizeDateValue(administeredRaw);
    if (!administeredAt) {
      errors.push(
        `Row ${i + 1}: dateGiven must be a date (like 2025-10-04 or 10/4/2025), got "${administeredRaw ?? ""}".`
      );
      return;
    }

    const dueRaw = fromAliases(r, VACCINATION_ALIASES.nextDueDate);
    const nextDueDate = dueRaw ? normalizeDateValue(dueRaw) ?? undefined : undefined;
    if (dueRaw && !nextDueDate) {
      errors.push(
        `Row ${i + 1}: nextDueDate could not be read as a date (got "${dueRaw}"); the row imports without it.`
      );
    }

    records.push({
      clientEmail,
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
 * pet, mapped to a SOAP note. Rows link to pets by owner email + pet name, so
 * run it AFTER clients and patients. A row needs a readable date and at least
 * one note section; the visit date is preserved so the history reads in order.
 */
export function csvToSoapNoteRecords(
  csv: string
): ParseResult<SoapNoteImportRecord> {
  const { rows, errors: parseErrors } = parseCsv(csv);
  const records: SoapNoteImportRecord[] = [];
  const errors: string[] = [...parseErrors];

  if (parseErrors.length > 0) {
    return { records, errors };
  }

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    const clientEmail = fromAliases(r, SOAP_NOTE_ALIASES.clientEmail);
    const patientName = fromAliases(r, SOAP_NOTE_ALIASES.patientName);
    const dateRaw = fromAliases(r, SOAP_NOTE_ALIASES.date);

    if (!clientEmail) {
      errors.push(
        `Row ${i + 1}: clientEmail is required to link the note to a pet.`
      );
      return;
    }
    if (!patientName) {
      errors.push(`Row ${i + 1}: patientName is required.`);
      return;
    }
    const date = normalizeDateValue(dateRaw);
    if (!date) {
      errors.push(
        `Row ${i + 1}: date must be a date (like 2025-10-04 or 10/4/2025), got "${dateRaw ?? ""}".`
      );
      return;
    }

    // Explicit SOAP columns win; a single free-text note column falls back to
    // Subjective so nothing is lost when the export is not SOAP structured.
    const subjective =
      fromAliases(r, SOAP_NOTE_ALIASES.subjective) ??
      fromAliases(r, SOAP_NOTE_ALIASES.note);
    const objective = fromAliases(r, SOAP_NOTE_ALIASES.objective);
    const assessment = fromAliases(r, SOAP_NOTE_ALIASES.assessment);
    const plan = fromAliases(r, SOAP_NOTE_ALIASES.plan);

    if (!subjective && !objective && !assessment && !plan) {
      errors.push(
        `Row ${i + 1}: needs at least one note (Subjective, Objective, Assessment, Plan, or a Notes column).`
      );
      return;
    }

    records.push({
      clientEmail,
      patientName,
      date,
      subjective,
      objective,
      assessment,
      plan,
    });
  });

  return { records, errors };
}
