# Shepherd migration archive preflight

This operator procedure inventories a clinic migration ZIP without extracting
it. It runs locally, reads no database, makes no network request, and writes one
aggregate evidence file with mode `0600`.

It is a structural safety and CSV compatibility check. It is not proof that a
file can be imported and it does not claim that unsupported records have been
migrated.

## Private workspace

Use an encrypted, clinic-authorized workstation. Create a private directory
outside the OpenVPM repository and outside cloud-synced folders. Keep the
original archives there with permissions limited to the current user. The tool
enforces that the containing private directory, manifest, and archives are
owned by the current user and grant no permissions to group or other users. Use
`chmod 700` for the containing directory and `chmod 600` for the manifest and
archives as the recommended operator setup; more restrictive owner permissions
also satisfy the privacy check. Do not put private names in any directory or
filename. The evidence file is created with mode `0600`.

The command rejects manifest, archive, and evidence paths inside the repository.
It also rejects symbolic-link inputs and refuses to overwrite an evidence file.

Create a `0600` manifest with this exact shape:

```json
{
  "archives": [
    "/absolute/private/path/archive-a.zip",
    "/absolute/private/path/archive-b.zip"
  ],
  "evidence": "/absolute/private/path/preflight-evidence.json"
}
```

The manifest keeps archive and evidence paths out of shell history and process
listings. Give the manifest itself an opaque path.

## Run

From `apps/web`, use opaque local archive names:

```sh
pnpm migration:preflight-archives \
  --manifest /absolute/private/path/archive-manifest.json
```

The terminal prints only a generic completion or failure message. It never
prints input paths, entry names, CSV headers, source values, or parser errors.

Exit status `0` means the archive structure is safe for the next review. Exit
status `2` means the evidence was written but at least one archive was blocked.
Exit status `1` means the command itself could not complete safely.

## What is rejected

The preflight rejects self-extracting, ZIP64, and multi-disk ZIPs; encrypted or
unsupported ZIP flags and compression methods; data descriptors; recognized
nested-archive names and ZIP magic in CSV candidates; absolute, Windows,
backslash, empty, dot, or parent paths; NFKC-normalized, case-insensitive, and
file/directory-prefix path collisions; symbolic links, special files, and
directory payloads; malformed or non-contiguous local spans; CSV CRC failures;
invalid UTF-8 CSVs; and bounded-size or CSV compression-ratio violations. It
never uses archive entry paths to create files.

CSV candidates must fit the same limits as the product: at most 5,000,000
UTF-8 bytes and at most 10,000 source rows. Candidate bytes are held only in
memory and passed through the existing client, patient, vaccination, and SOAP
CSV mappers. Before that eager parser boundary, a quote-aware scan bounds input
to 10,001 logical records including the header and blank records, 512 columns
per logical record, and 1,000,000 total cells. Raw mapper errors are converted
to fixed aggregate categories.

Evidence growth is also bounded to 128 CSV candidates per archive and 256 CSV
candidates across the manifest. Total advertised entries across the manifest
are capped at 100,000.

## Evidence review

The JSON evidence contains only:

- opaque archive and entry identifiers;
- SHA-256 content identities, sizes, counts, and safety codes;
- CRC and UTF-8 results;
- supported import mode candidates and aggregate row/error counts;
- exact duplicate-content counts across the supplied archives;
- explicit `networkUsed`, `databaseUsed`, `archiveExtractionUsed`, and
  `authoritativeImportClaim` flags.

It contains no filenames, paths, headers, cell values, names, contact details,
clinical notes, external identifiers, or raw parser messages. Do not commit the
evidence file even though it is privacy-minimized.

Unsupported non-CSV entry headers and spans are structurally validated, but
their payloads are not decompressed, CRC-checked, content-hashed, or scanned for
disguised nested formats. They remain opaque and are counted only. Their
presence sets `requiresUnsupportedDataReview`; they must not be treated as
migrated or content-verified.

## Authoritative preview

After the offline evidence and any required header mapping have been reviewed,
use the platform's administrator CSV dry-run. Keep the migration source exactly
`shepherd` and use the reviewed protocol. Process clients first, then patients,
then vaccinations, then SOAP notes. The server preview is the authoritative
duplicate, reconciliation, and unmatched-record plan; this offline tool is not.
