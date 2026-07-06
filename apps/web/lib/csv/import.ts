import { parseCsv, normalizeRow } from "./parse";

/**
 * Map parsed CSV rows into the record shapes the data router's import
 * mutations expect. Header matching is normalized (case/spacing/underscore
 * insensitive). Returns valid records plus per-row errors so a partial import
 * can proceed and report what it skipped. Pure — no I/O.
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

export interface ParseResult<T> {
  records: T[];
  errors: string[];
}

const SPECIES = ["canine", "feline", "avian", "rabbit", "reptile", "equine", "other"];
const SEXES = ["male", "female", "male_neutered", "female_spayed"];

function opt(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
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
    const firstName = opt(r.firstname);
    const lastName = opt(r.lastname);
    if (!firstName || !lastName) {
      errors.push(`Row ${i + 1}: firstName and lastName are required.`);
      return;
    }
    records.push({
      firstName,
      lastName,
      email: opt(r.email),
      phone: opt(r.phone),
      address: opt(r.address),
      city: opt(r.city),
      state: opt(r.state),
      zip: opt(r.zip),
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
    const clientEmail = opt(r.clientemail) ?? opt(r.email);
    const name = opt(r.name) ?? opt(r.patientname);
    const species = opt(r.species)?.toLowerCase();

    if (!clientEmail) {
      errors.push(`Row ${i + 1}: clientEmail is required to link the pet to an owner.`);
      return;
    }
    if (!name) {
      errors.push(`Row ${i + 1}: name is required.`);
      return;
    }
    if (!species || !SPECIES.includes(species)) {
      errors.push(
        `Row ${i + 1}: species must be one of ${SPECIES.join(", ")} (got "${species ?? ""}").`
      );
      return;
    }

    const sex = opt(r.sex)?.toLowerCase();
    records.push({
      clientEmail,
      name,
      species: species as PatientImportRecord["species"],
      breed: opt(r.breed),
      sex: sex && SEXES.includes(sex) ? (sex as PatientImportRecord["sex"]) : undefined,
      dob: opt(r.dob),
      color: opt(r.color),
      microchipNumber: opt(r.microchipnumber) ?? opt(r.microchip),
    });
  });

  return { records, errors };
}
