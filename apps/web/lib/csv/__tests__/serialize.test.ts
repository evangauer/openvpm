import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { csvToClientRecords } from "../import";
import { parseCsv } from "../parse";
import {
  csvCell,
  neutralizeCsvFormula,
  recordsToCsv,
  rowsToCsv,
  unescapeCsvFormulaPrefix,
} from "../serialize";

describe("csvCell", () => {
  it("writes null and undefined as empty fields", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("leaves plain text unquoted", () => {
    expect(csvCell("Bella")).toBe("Bella");
    expect(csvCell("")).toBe("");
  });

  it.each(["=HYPERLINK(\"http://x\",\"y\")", "=1+1", "+1+1", "-2+3", "@SUM(A1)"])(
    "prefixes formula-leading text %s with a single quote",
    (value) => {
      expect(neutralizeCsvFormula(value)).toBe(`'${value}`);
      expect(csvCell(value).replace(/^"/, "")).toMatch(/^'/);
    },
  );

  it("neutralizes leading tab and carriage return", () => {
    expect(csvCell("\t=cmd")).toBe("'\t=cmd");
    expect(csvCell("\r=cmd")).toBe("\"'\r=cmd\"");
    expect(csvCell("\n=cmd")).toBe("\"'\n=cmd\"");
  });

  it("neutralizes a DDE payload", () => {
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
  });

  it("quotes and escapes a formula that also contains quotes and commas", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"',
    );
  });

  it("does not prefix formula characters that are not leading", () => {
    expect(csvCell("Smith-Jones")).toBe("Smith-Jones");
    expect(csvCell("a@b.com")).toBe("a@b.com");
    expect(csvCell("1+1")).toBe("1+1");
  });

  it("keeps numbers, including negatives, as numbers", () => {
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(42n)).toBe("42");
    // Postgres numeric columns arrive as strings.
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("+3")).toBe("+3");
    expect(csvCell("-.5")).toBe("-.5");
    expect(csvCell("-1e3")).toBe("-1e3");
  });

  it("prefixes number-like strings that are not plain numbers", () => {
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("+1 (555) 010-0100")).toBe("'+1 (555) 010-0100");
    expect(csvCell("-")).toBe("'-");
  });

  it("quotes fields with commas, quotes, CR or LF and doubles quotes", () => {
    expect(csvCell("Austin, TX")).toBe('"Austin, TX"');
    expect(csvCell('Max "the dog"')).toBe('"Max ""the dog"""');
    expect(csvCell("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(csvCell("line 1\r\nline 2")).toBe('"line 1\r\nline 2"');
  });

  it("passes unicode through unchanged", () => {
    expect(csvCell("Zoë 🐾 日本")).toBe("Zoë 🐾 日本");
    expect(csvCell("Müller, Jürgen")).toBe('"Müller, Jürgen"');
  });

  it("writes booleans and dates predictably", () => {
    expect(csvCell(true)).toBe("true");
    expect(csvCell(new Date("2026-06-27T12:00:00.000Z"))).toBe(
      "2026-06-27T12:00:00.000Z",
    );
  });

  it("escapes values that already start with a quote before a trigger", () => {
    expect(csvCell("'=x")).toBe("''=x");
    expect(csvCell("'-5")).toBe("''-5");
    expect(csvCell("'hello")).toBe("'hello");
  });
});

describe("unescapeCsvFormulaPrefix", () => {
  it.each([
    "=1+1",
    "'=1+1",
    "''=1+1",
    "-5",
    "'-5",
    "+1 (555) 010-0100",
    "@me",
    "\tx",
    "\nx",
    "'\nx",
    "'hello",
    "O'Brien",
    "plain",
  ])("reverses neutralizeCsvFormula for %j", (value) => {
    expect(unescapeCsvFormulaPrefix(neutralizeCsvFormula(value))).toBe(value);
  });
});

describe("rowsToCsv / recordsToCsv", () => {
  it("joins rows with CRLF and adds no BOM", () => {
    const csv = rowsToCsv([
      ["a", "b"],
      [1, "x"],
    ]);
    expect(csv).toBe("a,b\r\n1,x");
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("uses the first record's keys as the header", () => {
    expect(
      recordsToCsv([
        { name: "Bella", notes: null },
        { name: "=evil", notes: "a\nb" },
      ]),
    ).toBe('name,notes\r\nBella,\r\n\'=evil,"a\nb"');
  });

  it("returns an empty string for no records", () => {
    expect(recordsToCsv([])).toBe("");
  });

  it("keeps every row's columns aligned when parsed back", () => {
    const records = [
      {
        firstName: '=HYPERLINK("http://x","y")',
        lastName: "O'Brien, Jr.",
        notes: 'Line 1\nLine 2, "quoted"',
        total: "-12.50",
      },
      { firstName: "Zoë", lastName: "-Smith", notes: "\r\n", total: -3 },
    ];
    const { rows, errors } = parseCsv(recordsToCsv(records));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        firstName: '=HYPERLINK("http://x","y")',
        lastName: "O'Brien, Jr.",
        notes: 'Line 1\nLine 2, "quoted"',
        total: "-12.50",
      },
      // parseCsv trims cells and normalizes line breaks.
      { firstName: "Zoë", lastName: "-Smith", notes: "", total: "-3" },
    ]);
  });

  it("round-trips a Settings client export through the client importer", () => {
    const csv = recordsToCsv([
      {
        firstName: "=Ann",
        lastName: "+Lee",
        email: "ann@example.com",
        phone: "+1 (555) 010-0100",
        address: "1 Main St, Apt 2",
        city: "Austin",
        state: "TX",
        zip: "78701",
        notes: "Prefers mornings\nCall first",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
    const { records, errors } = csvToClientRecords(csv);
    expect(errors).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        firstName: "=Ann",
        lastName: "+Lee",
        email: "ann@example.com",
        phone: "+1 (555) 010-0100",
        address: "1 Main St, Apt 2",
      }),
    ]);
  });
});

describe("CSV export call sites", () => {
  const settings = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");
  const reports = readFileSync("app/(dashboard)/reports/page.tsx", "utf8");

  it("Settings data export uses the shared serializer", () => {
    expect(settings).toContain(
      'import { downloadCsv, recordsToCsv } from "@/lib/csv/serialize";',
    );
    const helper = settings.slice(
      settings.indexOf("function downloadCSV"),
      settings.indexOf("function downloadJSON"),
    );
    expect(helper).toContain("downloadCsv(filename, recordsToCsv(data))");
    expect(helper).not.toContain('replace(/"/g');
  });

  it("report exports use the shared serializer", () => {
    expect(reports).toContain(
      'import { downloadCsv, rowsToCsv } from "@/lib/csv/serialize";',
    );
    expect(reports).not.toMatch(/function csvCell/);
    for (const tab of ["revenue", "appointments", "services", "inventory"]) {
      expect(reports).toContain(`downloadReportCsv(reportFilename("${tab}"`);
    }
  });
});
