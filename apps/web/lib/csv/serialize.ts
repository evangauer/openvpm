/**
 * Shared CSV writer for every CSV that OpenVPM produces (Settings → Data
 * exports, report exports). Pure apart from `downloadCsv`, which needs a DOM.
 *
 * - RFC 4180: fields containing a comma, double quote, CR or LF are quoted,
 *   embedded quotes are doubled, and rows end with CRLF. Semicolons and tabs
 *   are quoted too, because Excel in many locales splits a CSV on `;`, and an
 *   unquoted `a;=1+1` would start a new cell that runs as a formula.
 * - Spreadsheet formula injection (OWASP "CSV Injection"): text that starts
 *   with `=`, `+`, `-`, `@`, tab, CR or LF is prefixed with a single quote so
 *   Excel, Sheets and LibreOffice show it as text instead of evaluating it.
 *   Client names, notes and other free text are entered by clinic staff and
 *   sometimes by clients themselves, so they must never run as formulas.
 *
 * Numbers are left alone. JS numbers/bigints are never prefixed, and neither
 * are strings that are a plain decimal number (e.g. "-12.50" — Postgres
 * numeric columns arrive as strings). A plain number cannot carry a formula,
 * and prefixing it would turn refunds and adjustments into text that
 * spreadsheets can no longer sum. Deciding per value keeps one helper usable
 * for every export without each call site declaring column types.
 *
 * The prefix is reversible: `parseCsv` strips it again (see
 * `unescapeCsvFormulaPrefix`) so an exported file can be imported back without
 * leaving a stray quote on names. Values that already start with one or more
 * quotes followed by a trigger character get one extra quote, so the round
 * trip is exact.
 */

// OWASP's list (= + - @ tab CR) plus LF, because importers normalize CR to LF.
const FORMULA_TRIGGER = /^'*[=+\-@\t\r\n]/;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NEEDS_QUOTES = /[",;\t\r\n]/;

/** Prefix a single quote when `text` would be read as a spreadsheet formula. */
export function neutralizeCsvFormula(text: string): string {
  if (!FORMULA_TRIGGER.test(text) || PLAIN_NUMBER.test(text)) return text;
  return `'${text}`;
}

/** Inverse of `neutralizeCsvFormula`, applied when importing CSV cells. */
export function unescapeCsvFormulaPrefix(text: string): string {
  return /^'(?='*[=+\-@\t\r\n])/.test(text) ? text.slice(1) : text;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Timestamps are written in the viewer's local time as `yyyy-MM-dd HH:mm`,
 * which Excel and Sheets read as a date, rather than UTC ISO strings.
 */
function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Encode one value as a CSV field. null/undefined become an empty field. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  const text = neutralizeCsvFormula(
    value instanceof Date ? formatTimestamp(value) : String(value),
  );
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize rows (first row is usually the header) to RFC 4180 CSV text. */
export function rowsToCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Serialize objects to CSV, using the first record's keys as the header row.
 * Returns an empty string when there are no records.
 */
export function recordsToCsv(records: readonly Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]!);
  return rowsToCsv([
    headers,
    ...records.map((record) => headers.map((header) => record[header])),
  ]);
}

/** Trigger a browser download of CSV text. Client components only. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
