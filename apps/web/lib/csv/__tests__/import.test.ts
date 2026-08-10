import { describe, it, expect } from "vitest";
import { parseCsv, normalizeKey } from "../parse";
import {
  csvToClientRecords,
  csvToPatientRecords,
  csvToVaccinationRecords,
  csvToSoapNoteRecords,
} from "../import";

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

  it("strips a UTF-8 byte-order mark from the first header", () => {
    const result = parseCsv("\uFEFFFirst Name,Last Name\nJane,Doe");

    expect(result.errors).toEqual([]);
    expect(result.headers).toEqual(["First Name", "Last Name"]);
    expect(result.rows[0]).toEqual({
      "First Name": "Jane",
      "Last Name": "Doe",
    });
  });

  it("rejects duplicate headers after normalization instead of overwriting a value", () => {
    const result = parseCsv("First Name,first_name,Last Name\nJane,Janet,Doe");

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringMatching(/duplicate columns.*First Name.*first_name/i),
    ]);
  });

  it("rejects blank or non-alphanumeric headers", () => {
    const result = parseCsv("First Name,,---\nJane,unused,unused");

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      "CSV header column 2 is blank or invalid.",
      "CSV header column 3 is blank or invalid.",
    ]);
  });

  it("rejects extra columns instead of silently discarding data", () => {
    const result = parseCsv("a,b\n1\n2,3,4");

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      "Row 2 has 3 columns; expected at most 2. Check for an extra or unquoted comma.",
    ]);
  });

  it("maps omitted trailing fields to empty values", () => {
    const result = parseCsv("a,b\n1");

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([{ a: "1", b: "" }]);
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
    const csv =
      "First Name,Last Name,Email\nJane,Doe,jane@x.com\n,Smith,bob@x.com";
    const { records, errors } = csvToClientRecords(csv);
    expect(records).toEqual([
      { firstName: "Jane", lastName: "Doe", email: "jane@x.com" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Row 2/);
  });

  it("does not map records from malformed quoted CSV", () => {
    const { records, errors } = csvToClientRecords(
      'First Name,Last Name\n"Jane,Doe',
    );

    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });

  it("does not map records when a row has the wrong number of columns", () => {
    const { records, errors } = csvToClientRecords(
      "First Name,Last Name,Email\nJane,Doe,jane@example.com,extra",
    );

    expect(records).toEqual([]);
    expect(errors).toEqual([
      "Row 1 has 4 columns; expected at most 3. Check for an extra or unquoted comma.",
    ]);
  });

  it("rejects an empty or header-only file before import", () => {
    expect(csvToClientRecords("")).toEqual({
      records: [],
      errors: ["CSV is empty or is missing a header row."],
    });
    expect(csvToClientRecords("First Name,Last Name\n")).toEqual({
      records: [],
      errors: ["CSV has a header row but no data rows."],
    });
  });

  it("reports missing columns once at file level without echoing row data", () => {
    const csv =
      "Full Name,Email\n" +
      "Sensitive Client Name,sensitive@example.com\n".repeat(100);
    const { records, errors } = csvToClientRecords(csv);

    expect(records).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/missing a recognized client first-name column/i);
    expect(errors[1]).toMatch(/missing a recognized client last-name column/i);
    expect(errors.join(" ")).not.toContain("Sensitive Client Name");
    expect(errors.join(" ")).not.toContain("sensitive@example.com");
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
      'clientEmail,name,species\n"owner@example.com,Rex,canine',
    );

    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });

  it("reads real-export headers and values (migration aliases)", () => {
    // AVImark-style export: friendly headers, dog/cat species, MN sex,
    // US-format birthday. All should normalize without hand-editing.
    const csv =
      "Owner Email,Pet Name,Species,Gender,Birthday,Microchip\n" +
      "jane@x.com,Rex,Dog,MN,3/5/2019,985112004\n" +
      "jane@x.com,Tweety,Bird,F,2020-01-15,";
    const { records, errors } = csvToPatientRecords(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      clientEmail: "jane@x.com",
      name: "Rex",
      species: "canine",
      sex: "male_neutered",
      dob: "2019-03-05",
      microchipNumber: "985112004",
    });
    expect(records[1]).toMatchObject({
      name: "Tweety",
      species: "avian",
      sex: "female",
      dob: "2020-01-15",
    });
  });

  it("passes unreadable DOBs through so the router reports them precisely", () => {
    const csv =
      "clientEmail,name,species,dob\njane@x.com,Rex,canine,last spring";
    const { records } = csvToPatientRecords(csv);
    expect(records[0]!.dob).toBe("last spring");
  });

  it("maps an ID-linked raw PIMS patient table without requiring owner email", () => {
    const csv =
      "Client ID,Patient Name,Species\n" + "client-4839,Rex,Dog\n".repeat(100);
    const { records, errors } = csvToPatientRecords(csv);

    expect(records).toHaveLength(100);
    expect(records[0]).toMatchObject({
      externalClientId: "client-4839",
      name: "Rex",
      species: "canine",
    });
    expect(errors).toEqual([]);
  });

  it("reports absent required headers before producing per-row errors", () => {
    const { records, errors } = csvToPatientRecords(
      "Owner Email,Patient Name\nowner@example.com,Rex",
    );

    expect(records).toEqual([]);
    expect(errors).toEqual([
      expect.stringMatching(/missing a recognized species column/i),
    ]);
  });
});

describe("csvToClientRecords migration aliases", () => {
  it("reads owner-style headers from real exports", () => {
    const csv =
      "Owner First Name,Surname,Email Address,Cell Phone,Street Address,Town,Province,Postal Code\n" +
      "Jane,Doe,jane@x.com,555-0100,1 Main St,Boise,ID,83701";
    const { records, errors } = csvToClientRecords(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      phone: "555-0100",
      address: "1 Main St",
      city: "Boise",
      state: "ID",
      zip: "83701",
    });
  });

  it("preserves opaque external client IDs including leading zeroes and case", () => {
    const { records, errors } = csvToClientRecords(
      "Owner ID,First Name,Last Name\n00AbC-19,Jane,Doe",
    );

    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalClientId: "00AbC-19",
      firstName: "Jane",
      lastName: "Doe",
    });
  });
});

describe("csvToVaccinationRecords", () => {
  it("accepts a direct patient ID without owner email or patient name", () => {
    const { records, errors } = csvToVaccinationRecords(
      "Patient ID,Vaccine,Date Given\nPET-002,Rabies,2025-01-01",
    );

    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalPatientId: "PET-002",
      vaccineName: "Rabies",
    });
  });
  it("maps vaccine history rows with alias headers and US dates", () => {
    const csv =
      "Owner Email,Pet Name,Vaccine,Date Given,Due Date,Lot,Manufacturer\n" +
      "jane@x.com,Rex,Rabies 3yr,10/4/2024,10/4/2027,RB-771,Zoetis";
    const { records, errors } = csvToVaccinationRecords(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toEqual({
      clientEmail: "jane@x.com",
      patientName: "Rex",
      vaccineName: "Rabies 3yr",
      administeredAt: "2024-10-04",
      nextDueDate: "2027-10-04",
      lotNumber: "RB-771",
      manufacturer: "Zoetis",
    });
  });

  it("requires an owner email, pet name, vaccine, and readable date given", () => {
    const csv =
      "clientEmail,patientName,vaccineName,dateGiven\n" +
      ",Rex,Rabies,10/4/2024\n" +
      "jane@x.com,,Rabies,10/4/2024\n" +
      "jane@x.com,Rex,,10/4/2024\n" +
      "jane@x.com,Rex,Rabies,someday";
    const { records, errors } = csvToVaccinationRecords(csv);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(
      /Row 1: a patient ID or owner reference is required/,
    );
    expect(errors[1]).toMatch(/Row 2: patientName is required/);
    expect(errors[2]).toMatch(/Row 3: vaccineName is required/);
    expect(errors[3]).toMatch(/Row 4: dateGiven must be a date/);
  });

  it("imports a row without its due date when only the due date is unreadable", () => {
    const csv =
      "clientEmail,patientName,vaccineName,dateGiven,nextDueDate\n" +
      "jane@x.com,Rex,DHPP,2024-06-01,when due";
    const { records, errors } = csvToVaccinationRecords(csv);
    expect(records).toHaveLength(1);
    expect(records[0]!.nextDueDate).toBeUndefined();
    expect(errors[0]).toMatch(/nextDueDate could not be read/);
  });

  it("does not map vaccination records from malformed quoted CSV", () => {
    const { records, errors } = csvToVaccinationRecords(
      'clientEmail,patientName,vaccineName,dateGiven\n"jane@x.com,Rex',
    );
    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });

  it("maps vaccination rows by external owner ID plus patient name", () => {
    const { records, errors } = csvToVaccinationRecords(
      "Account Number,Patient Name,Vaccine,Date Given\n42,Rex,Rabies,2025-01-01",
    );

    expect(records).toEqual([
      expect.objectContaining({
        externalClientId: "42",
        patientName: "Rex",
        vaccineName: "Rabies",
      }),
    ]);
    expect(errors).toEqual([]);
  });
});

describe("csvToSoapNoteRecords", () => {
  it("accepts a direct patient ID without owner email or patient name", () => {
    const { records, errors } = csvToSoapNoteRecords(
      "Patient ID,Visit Date,Notes\nPET-002,2025-01-01,Annual exam",
    );

    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalPatientId: "PET-002",
      date: "2025-01-01",
      subjective: "Annual exam",
    });
  });
  it("maps split SOAP columns with alias headers and US dates", () => {
    const csv =
      "Owner Email,Pet Name,Visit Date,Subjective,Objective,Assessment,Plan\n" +
      "jane@x.com,Rex,3/5/2024,Vomiting since Tuesday,BAR T 101.2,Gastritis,Bland diet + recheck";
    const { records, errors } = csvToSoapNoteRecords(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toEqual({
      clientEmail: "jane@x.com",
      patientName: "Rex",
      date: "2024-03-05",
      subjective: "Vomiting since Tuesday",
      objective: "BAR T 101.2",
      assessment: "Gastritis",
      plan: "Bland diet + recheck",
    });
  });

  it("lands a single free-text notes column in the Subjective section", () => {
    const csv =
      "clientEmail,patientName,date,notes\n" +
      "jane@x.com,Rex,2024-03-05,Annual wellness exam. All normal.";
    const { records, errors } = csvToSoapNoteRecords(csv);
    expect(errors).toEqual([]);
    expect(records[0]).toEqual({
      clientEmail: "jane@x.com",
      patientName: "Rex",
      date: "2024-03-05",
      subjective: "Annual wellness exam. All normal.",
      objective: undefined,
      assessment: undefined,
      plan: undefined,
    });
  });

  it("keeps an explicit subjective column and routes a standalone notes column to the next empty section (no data loss)", () => {
    const csv =
      "clientEmail,patientName,date,history,clinicalNotes\n" +
      'jane@x.com,Rex,2024-03-05,Vomiting x2 days,"Exam: T 103.1, dehydrated. Dx gastroenteritis. Tx SQ fluids."';
    const { records } = csvToSoapNoteRecords(csv);
    expect(records[0]).toMatchObject({
      subjective: "Vomiting x2 days",
      objective: "Exam: T 103.1, dehydrated. Dx gastroenteritis. Tx SQ fluids.",
    });
  });

  it("skips a row with a malformed email and keeps the valid rows (no whole-file abort)", () => {
    const csv =
      "clientEmail,patientName,date,notes\n" +
      "jane@x.com,Rex,2024-03-05,Annual exam\n" +
      "none,Bella,2024-03-06,Vaccine visit";
    const { records, errors } = csvToSoapNoteRecords(csv);
    expect(records).toHaveLength(1);
    expect(records[0]!.patientName).toBe("Rex");
    expect(
      errors.some((e) => /Row 2: clientEmail is not a valid email/.test(e)),
    ).toBe(true);
  });

  it("flags an over-long note section as a row issue instead of failing the file", () => {
    const csv =
      "clientEmail,patientName,date,notes\n" +
      `jane@x.com,Rex,2024-03-05,${"x".repeat(10001)}`;
    const { records, errors } = csvToSoapNoteRecords(csv);
    expect(records).toEqual([]);
    expect(errors[0]).toMatch(/subjective note is too long/);
  });

  it("maps diagnosis and history synonyms onto assessment and subjective", () => {
    const csv =
      "clientEmail,patientName,date,history,diagnosis\n" +
      "jane@x.com,Rex,2024-03-05,Coughing,Kennel cough";
    const { records } = csvToSoapNoteRecords(csv);
    expect(records[0]).toMatchObject({
      subjective: "Coughing",
      assessment: "Kennel cough",
    });
  });

  it("requires an owner email, pet name, readable date, and some note", () => {
    const csv =
      "clientEmail,patientName,date,notes\n" +
      ",Rex,2024-03-05,note\n" +
      "jane@x.com,,2024-03-05,note\n" +
      "jane@x.com,Rex,someday,note\n" +
      "jane@x.com,Rex,2024-03-05,";
    const { records, errors } = csvToSoapNoteRecords(csv);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(
      /Row 1: a patient ID or owner reference is required/,
    );
    expect(errors[1]).toMatch(/Row 2: patientName is required/);
    expect(errors[2]).toMatch(/Row 3: date must be a date/);
    expect(errors[3]).toMatch(/Row 4: needs at least one note/);
  });

  it("does not map notes from malformed quoted CSV", () => {
    const { records, errors } = csvToSoapNoteRecords(
      'clientEmail,patientName,date,notes\n"jane@x.com,Rex',
    );
    expect(records).toEqual([]);
    expect(errors).toEqual(["CSV has an unterminated quoted field."]);
  });

  it("requires a recognized note-content column at file preflight", () => {
    const { records, errors } = csvToSoapNoteRecords(
      "Owner Email,Patient Name,Visit Date,Provider\nowner@example.com,Rex,2025-01-01,Dr. Example",
    );

    expect(records).toEqual([]);
    expect(errors).toEqual([
      expect.stringMatching(
        /missing a recognized medical-note content column/i,
      ),
    ]);
    expect(errors[0]).not.toContain("owner@example.com");
    expect(errors[0]).not.toContain("Rex");
  });
});
