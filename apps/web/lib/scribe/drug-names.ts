/**
 * Common veterinary drug, preventive, and product names, so Scribe spells them
 * right from a clinic's first day, before its own product list says what it
 * stocks. Speech recognition hears "maropitant" as "myropetin" and "Otomax" as
 * "automax" without a hint like this.
 *
 * Spelling help only. These names never add a drug to a note: the note
 * prompt says a drug may be written only when it was said.
 *
 * The first names are the ones said most often in a general companion-animal
 * visit, because short speech-to-text hints only take the start of the list.
 */
const MOST_SAID = [
  "maropitant",
  "Cerenia",
  "carprofen",
  "meloxicam",
  "gabapentin",
  "trazodone",
  "Apoquel",
  "Cytopoint",
  "Otomax",
  "Clavamox",
  "Convenia",
  "metronidazole",
  "Simparica Trio",
  "NexGard",
  "Bravecto",
  "Revolution Plus",
  "Heartgard Plus",
  "Credelio",
  "Galliprant",
  "Librela",
  "Solensia",
] as const;

const BY_TOPIC: readonly string[] = [
  // Parasite prevention
  "Simparica Trio",
  "Simparica",
  "NexGard",
  "NexGard Plus",
  "NexGard Spectra",
  "Bravecto",
  "Credelio",
  "Credelio Quattro",
  "Revolution Plus",
  "Revolution",
  "Heartgard Plus",
  "Interceptor Plus",
  "Sentinel Spectrum",
  "ProHeart",
  "Advantage Multi",
  "Frontline",
  "Seresto",
  "Trifexis",
  "Capstar",
  // Pain and inflammation
  "carprofen",
  "Rimadyl",
  "meloxicam",
  "Metacam",
  "robenacoxib",
  "Onsior",
  "grapiprant",
  "Galliprant",
  "gabapentin",
  "Librela",
  "Solensia",
  "buprenorphine",
  "trazodone",
  // Nausea and gut
  "maropitant",
  "Cerenia",
  "ondansetron",
  "metronidazole",
  "famotidine",
  "omeprazole",
  "sucralfate",
  "Proviable",
  "FortiFlora",
  "mirtazapine",
  "Mirataz",
  "capromorelin",
  "Entyce",
  // Antibiotics
  "amoxicillin",
  "Clavamox",
  "cefpodoxime",
  "Simplicef",
  "cephalexin",
  "Convenia",
  "enrofloxacin",
  "Baytril",
  "marbofloxacin",
  "doxycycline",
  "clindamycin",
  // Ears and skin
  "Otomax",
  "Mometamax",
  "Posatex",
  "Claro",
  "Osurnia",
  "Neptra",
  "Easotic",
  "Tresaderm",
  "Epi-Otic",
  "Zymox",
  "Apoquel",
  "oclacitinib",
  "Cytopoint",
  "Zenrelia",
  "Atopica",
  "cyclosporine",
  "prednisone",
  "prednisolone",
  "dexamethasone",
  "chlorhexidine",
  "ketoconazole",
  "terbinafine",
  // Heart, kidneys, hormones
  "pimobendan",
  "Vetmedin",
  "enalapril",
  "benazepril",
  "furosemide",
  "spironolactone",
  "amlodipine",
  "clopidogrel",
  "telmisartan",
  "Semintra",
  "methimazole",
  "Felimazole",
  "levothyroxine",
  "trilostane",
  "Vetoryl",
  "Vetsulin",
  "ProZinc",
  "Senvelgo",
  "Bexacat",
  "Zycortal",
  "Epakitin",
  "Azodyl",
  "calcitriol",
  // Seizures and behaviour
  "phenobarbital",
  "levetiracetam",
  "zonisamide",
  "potassium bromide",
  "fluoxetine",
  "clomipramine",
  "Sileo",
  "Bonqat",
  "acepromazine",
  // Sedation and anaesthesia
  "dexmedetomidine",
  "Dexdomitor",
  "atipamezole",
  "Antisedan",
  "butorphanol",
  "methadone",
  "hydromorphone",
  "ketamine",
  "midazolam",
  "propofol",
  "alfaxalone",
  "Alfaxan",
  "isoflurane",
  "lidocaine",
  "bupivacaine",
  "Nocita",
  // Deworming, urinary, joints, eyes, fluids
  "fenbendazole",
  "Panacur",
  "praziquantel",
  "pyrantel",
  "Drontal",
  "Profender",
  "Proin",
  "Incurin",
  "Adequan",
  "Dasuquin",
  "Denamarin",
  "ursodiol",
  "Neo-Poly-Dex",
  "Terramycin",
  "Optimmune",
  "tacrolimus",
  "lactated Ringer's",
  "Normosol",
  // Vaccines and tests clinicians say aloud
  "DHPP",
  "Bordetella",
  "leptospirosis",
  "FVRCP",
  "FeLV",
  "Nobivac",
  "Purevax",
  "SDMA",
  "cPL",
  "NT-proBNP",
  "fructosamine",
  "4Dx",
];

export const COMMON_VETERINARY_DRUG_NAMES: readonly string[] = [
  ...new Set<string>([...MOST_SAID, ...BY_TOPIC]),
];

/**
 * Spelling hints for speech-to-text: the clinic's own names first, then the
 * common list, within the hint's size limits. A clinic that stocks plenty of
 * products gets few common names; a new clinic gets many.
 */
export function withCommonDrugNames(
  clinicTerms: readonly string[],
  limits: { maxTerms: number; maxCharacters: number },
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  let characters = 0;
  for (const term of [...clinicTerms, ...COMMON_VETERINARY_DRUG_NAMES]) {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    if (characters + term.length + 2 > limits.maxCharacters) break;
    seen.add(key);
    terms.push(term);
    characters += term.length + 2;
    if (terms.length >= limits.maxTerms) break;
  }
  return terms;
}
