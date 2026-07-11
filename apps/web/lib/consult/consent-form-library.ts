import { DEFAULT_CONSENT_BODY, DEFAULT_CONSENT_TITLE } from "./consent-template";

/**
 * Starter consent form library, seeded per practice the first time the
 * form list is read. Practices edit these to fit how they work; staff can
 * still tweak the text per dispatch, and the sent copy is snapshotted on
 * the request either way.
 *
 * These are templates, not legal advice. The picker UI tells practices to
 * have their attorney look them over. Blank lines like "____" are meant to
 * be filled in by staff before sending.
 *
 * Voice: plain and warm, fourth-grade reading level, no em dashes.
 */

export type ConsentFormSeed = {
  slug: string;
  title: string;
  body: string;
  sortOrder: number;
};

export const CONSENT_FORM_LIBRARY: ConsentFormSeed[] = [
  {
    slug: "treatment",
    title: DEFAULT_CONSENT_TITLE,
    sortOrder: 0,
    body: DEFAULT_CONSENT_BODY,
  },
  {
    slug: "surgery-anesthesia",
    title: "Surgery and anesthesia consent",
    sortOrder: 1,
    body: [
      "I am the owner of this pet, or I am allowed to make decisions for this pet.",
      "",
      "Procedure: ____",
      "",
      "I give this clinic permission to do this procedure and to use anesthesia. The team explained what they plan to do and why. I had the chance to ask questions.",
      "",
      "I understand anesthesia and surgery have risks, including in rare cases death. The team will watch my pet closely the whole time.",
      "",
      "If the team finds something unexpected during the procedure, I give them permission to treat it using their best judgment. They will try to reach me first when it is safe to wait.",
      "",
      "My pet did not eat this morning, as instructed.",
      "",
      "My phone number for today: ____",
      "If my pet's heart stops, I choose (staff: circle before sending): CPR / no CPR.",
      "",
      "I have seen the estimate for this procedure. I agree to pay for the care my pet receives.",
    ].join("\n"),
  },
  {
    slug: "dental",
    title: "Dental cleaning and extractions consent",
    sortOrder: 2,
    body: [
      "I am the owner of this pet, or I am allowed to make decisions for this pet.",
      "",
      "I give this clinic permission to clean my pet's teeth under anesthesia and to take dental x-rays.",
      "",
      "Some tooth problems only show up once my pet is asleep and the x-rays are done. Waking my pet up to call me, then putting my pet under again another day, adds risk and cost.",
      "",
      "So I choose one (staff: circle before sending):",
      "1. The team may remove teeth that need it, up to $____ in total.",
      "2. Call me first before removing any teeth. If you cannot reach me, do not remove teeth.",
      "",
      "My phone number for today: ____",
      "",
      "I understand anesthesia has risks, and I agree to pay for the care my pet receives.",
    ].join("\n"),
  },
  {
    slug: "euthanasia",
    title: "Euthanasia authorization",
    sortOrder: 3,
    body: [
      "I certify that I own this pet, or that I am allowed to make this decision for this pet.",
      "",
      "I ask this clinic to humanely euthanize my pet. I understand this decision is final.",
      "",
      "To my knowledge, my pet has not bitten anyone in the last 10 days.",
      "",
      "Aftercare (staff: fill in before sending): ____",
      "Common choices: private cremation with ashes returned, communal cremation, or home burial where allowed.",
      "",
      "I agree to the fees for this service and the aftercare I chose.",
    ].join("\n"),
  },
  {
    slug: "estimate-approval",
    title: "Estimate approval",
    sortOrder: 4,
    body: [
      "The team walked me through the plan for my pet's care and gave me a written estimate.",
      "",
      "Estimated cost (staff: fill in before sending): $____ to $____",
      "",
      "I understand this is an estimate, not an exact price. If my pet needs more care than planned, the team will contact me before adding big new costs, unless it is an emergency.",
      "",
      "If my pet stays in the hospital, the team will update me on costs each day.",
      "",
      "I approve this plan and agree to pay for the care my pet receives.",
    ].join("\n"),
  },
  {
    slug: "vaccine-declination",
    title: "Vaccine declination",
    sortOrder: 5,
    body: [
      "The team recommended these vaccines for my pet (staff: fill in before sending): ____",
      "",
      "I am choosing not to vaccinate my pet today. The team explained the diseases these vaccines prevent and the risks of skipping them.",
      "",
      "I understand my pet will count as unvaccinated. If my pet is exposed to one of these diseases, or bites someone, that can have serious consequences for my pet.",
      "",
      "I accept these risks and will not hold the clinic responsible for illness these vaccines could have prevented.",
    ].join("\n"),
  },
  {
    slug: "boarding",
    title: "Boarding agreement",
    sortOrder: 6,
    body: [
      "I am the owner of this pet, or I am allowed to make decisions for this pet.",
      "",
      "My pet's vaccines are current, or I agree to have the clinic update them at my cost.",
      "",
      "If my pet gets sick or hurt while boarding, I give the clinic permission to treat my pet, up to $____. They will try to reach me first. If they cannot reach me within 4 hours in an emergency, they may treat my pet using their best judgment.",
      "",
      "My phone number while away: ____",
      "A person who can decide for me if I cannot be reached: ____",
      "",
      "Pickup date: ____. I understand that pets left more than 10 days past pickup without contact may be considered abandoned under state law.",
      "",
      "I agree to pay boarding fees and any care costs at pickup.",
    ].join("\n"),
  },
  {
    slug: "telehealth",
    title: "Telehealth visit consent",
    sortOrder: 7,
    body: [
      "I agree to a visit with the veterinary team by video or phone.",
      "",
      "I understand the team cannot examine my pet with their hands over video. Some problems cannot be diagnosed this way, and the team may ask me to bring my pet in.",
      "",
      "Telehealth is not for emergencies. If my pet is in danger, I will go to a clinic or emergency hospital right away.",
      "",
      "My location during this visit (city and state): ____",
      "",
      "I agree to the fee for this visit.",
    ].join("\n"),
  },
  {
    slug: "photo-release",
    title: "Photo and story release",
    sortOrder: 8,
    body: [
      "I give this clinic permission to take photos and videos of my pet and to share them, with my pet's first name, on the clinic's website and social media.",
      "",
      "I will not be paid for this. I can change my mind for future posts at any time by telling the clinic.",
      "",
      "Photos taken for my pet's medical record are separate. Those stay in the record either way.",
    ].join("\n"),
  },
  {
    slug: "records-release",
    title: "Medical records release",
    sortOrder: 9,
    body: [
      "I ask this clinic to share my pet's medical records.",
      "",
      "Send the records to (staff: fill in before sending): ____",
      "",
      "Which records: full history, or (staff: fill in): ____",
      "",
      "I am the owner of this pet, or I am allowed to make this request for this pet.",
    ].join("\n"),
  },
];
