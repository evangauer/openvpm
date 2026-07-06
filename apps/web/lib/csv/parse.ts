/**
 * Minimal, dependency-free RFC-4180-ish CSV parser. Handles quoted fields,
 * embedded commas/newlines, and escaped double-quotes (""). Returns the header
 * row plus rows keyed by header. Pure — no I/O.
 */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
}

export function parseCsv(text: string): ParsedCsv {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  const errors: string[] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) {
    return {
      headers: [],
      rows: [],
      errors: ["CSV has an unterminated quoted field."],
    };
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  // Drop blank lines (a lone empty field).
  const nonEmpty = records.filter(
    (r) => !(r.length === 1 && r[0].trim() === "")
  );
  if (nonEmpty.length === 0) return { headers: [], rows: [], errors };

  const headers = nonEmpty[0]!.map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? "").trim();
    });
    return obj;
  });

  return { headers, rows, errors };
}

/** Normalize a header to a comparison key: lowercase, alphanumerics only. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Re-key a parsed row by normalized header so "First Name" == "first_name". */
export function normalizeRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeKey(k)] = v;
  }
  return out;
}
