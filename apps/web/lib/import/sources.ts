/**
 * Migration source presets: where a clinic's data is coming from and how
 * to get it out of that system. The importers themselves are source
 * agnostic (header aliases + value normalization in lib/csv/import.ts);
 * these presets exist so the UI and docs can meet people where they are.
 * Voice: fourth grade, no em dashes.
 */

export interface MigrationSource {
  id: "avimark" | "cornerstone" | "ezyvet" | "shepherd" | "other";
  name: string;
  /** How to get CSV exports out of that system, in one breath. */
  exportHint: string;
}

export const MIGRATION_SOURCES: MigrationSource[] = [
  {
    id: "avimark",
    name: "AVImark",
    exportHint:
      "In AVImark, use Information Search to pull Clients and Patients, then choose Results, then Export and save as CSV. Your Covetrus rep can also send full exports.",
  },
  {
    id: "cornerstone",
    name: "Cornerstone",
    exportHint:
      "In Cornerstone, run the Client and Patient reports under Reports, then save or print each one to CSV. IDEXX support can also pull full exports for you.",
  },
  {
    id: "ezyvet",
    name: "ezyVet",
    exportHint:
      "In ezyVet, open the Records dashboard, search Contacts and Animals, and use Export to download CSV files.",
  },
  {
    id: "shepherd",
    name: "Shepherd",
    exportHint:
      "In Shepherd, use Reports to export your client and patient lists as CSV. For your full records, ask Shepherd support for your data export. Shepherd is cloud based, so support sends the files.",
  },
  {
    id: "other",
    name: "Another system or spreadsheet",
    exportHint:
      "Use a CSV with the columns shown below. The dry run shows exactly what will import before anything is saved.",
  },
];

/** Import order that always works: owners first, then pets, then history. */
export const MIGRATION_STEPS = [
  { mode: "clients" as const, label: "1. Clients (pet owners)" },
  { mode: "patients" as const, label: "2. Patients (pets)" },
  { mode: "vaccinations" as const, label: "3. Vaccine history" },
  { mode: "soapNotes" as const, label: "4. Medical history (visit notes)" },
];
