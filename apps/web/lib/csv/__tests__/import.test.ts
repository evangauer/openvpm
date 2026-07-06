import { describe, it, expect } from "vitest";
import { parseCsv, normalizeKey } from "../parse";
import { csvToClientRecords, csvToPatientRecords } from "../import";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const { headers, rows } = parseCsv("a,b\n1,2\n3,4");
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("handles quoted fields with embedded commas and quotes", () => {
    const { rows } = parseCsv('name,note\n"Doe, Jane","She said ""hi"""');
    expect(rows[0]).toEqual({ name: "Doe, Jane", note: 'She said "hi"' });
  });

  it("handles quoted fields with embedded newlines", () => {
    const { rows } = parseCsv('name,note\n"Rex","line1\nline2"');
    expect(rows[0]!.note).toBe("line1\nline2");
  });

  it("tolerates CRLF and a trailing newline", () => {
    const { rows } = parseCsv("a,b\r\n1,2\r\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ a: "1", b: "2" });
  });

  it("reports unterminated quoted fields instead of returning collapsed rows", () => {
    const result = parseCsv('name,note\n"Rex,line one\nLuna,line two');

    expect(result).toEqual({
      headers: [],
      rows: [],
      errors: ["CSV has an unterminated quoted field."],
    });
  });

  it("normalizeKey collapses case, spaces, and underscores", () => {
    expect(normalizeKey("First Name")).toBe("firstname");
    expect(normalizeKey("first_name")).toBe("firstname");
  });
});

describe("csvToClientRecords", () => {
  it("maps flexible headers and requires first/last name", () => {
    const csv = "First Name,Last Name,Email\nJane,Doe,jane@x.com\n,Smith,bob@x.com";
    const { records, errors } = csvToClientRecords(csv);
    expect(records).toEqual([
      { firstName: "Jane", lastName: "Doe", email: "jane@x.com" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Row 2/);
  });

  it("does not map records from malformed quoted CSV", () => {
    const { records, errors } = csvToClientRecords(
      'First Name,Last Name\n"Jane,Doe'
    );

    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });
});

describe("csvToPatientRecords", () => {
  it("validates species and links by client email", () => {
    const csv =
      "clientEmail,name,species,sex\njane@x.com,Rex,canine,male_neutered\njane@x.com,Mystery,dragon";
    const { records, errors } = csvToPatientRecords(csv);
    expect(records).toEqual([
      {
        clientEmail: "jane@x.com",
        name: "Rex",
        species: "canine",
        sex: "male_neutered",
        breed: undefined,
        dob: undefined,
        color: undefined,
        microchipNumber: undefined,
      },
    ]);
    expect(errors[0]).toMatch(/species must be one of/);
  });

  it("drops an invalid sex rather than failing the row", () => {
    const csv = "clientEmail,name,species,sex\njane@x.com,Rex,feline,unknown";
    const { records } = csvToPatientRecords(csv);
    expect(records[0]!.sex).toBeUndefined();
    expect(records[0]!.species).toBe("feline");
  });

  it("does not map patient records from malformed quoted CSV", () => {
    const { records, errors } = csvToPatientRecords(
      'clientEmail,name,species\n"owner@example.com,Rex,canine'
    );

    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });
});
