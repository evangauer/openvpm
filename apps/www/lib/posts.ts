/**
 * Thought-leadership content for the OpenVPM blog. Stored as structured blocks
 * (zero dependencies, fully type-checked) and rendered by app/blog. Add a post
 * by appending to `posts` — newest first.
 */

export type Block =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "quote"; text: string };

export interface Post {
  slug: string;
  title: string;
  /** Display date, e.g. "June 3, 2026". */
  date: string;
  author: string;
  excerpt: string;
  readingMinutes: number;
  content: Block[];
}

export const posts: Post[] = [
  {
    slug: "why-veterinary-software-should-be-open",
    title: "Why veterinary software should be open",
    date: "June 3, 2026",
    author: "Evan Gauer",
    excerpt:
      "Every other part of the clinic is built on standards. The software that runs it shouldn't be a locked box you rent forever.",
    readingMinutes: 4,
    content: [
      { type: "p", text: "Walk into any veterinary clinic and almost everything follows a standard. Drugs have monographs. Labs report against reference ranges. Anesthesia has protocols. Then you get to the software that ties it all together — the practice management system — and the standards disappear. Your data lives in a format only the vendor can read. The API, if there is one, is locked behind a partnership team. And the bill arrives every month whether the software got better or not." },
      { type: "h2", text: "Closed software is a tax on the whole industry" },
      { type: "p", text: "When the system of record is closed, every good idea downstream gets harder. A reminder tool has to beg for integration access. An AI scribe can read but not write. A new analytics product can't get the data out. The clinic that wants to switch finds out their five years of records are effectively hostage. None of this is about bad people — it's about incentives. A closed PIMS makes more money the harder it is to leave." },
      { type: "quote", text: "The best software for veterinary medicine should be built with the veterinary community, not sold to it." },
      { type: "h2", text: "What open changes" },
      { type: "ul", items: [
        "Your data is yours. Full export, any time, in a format you can read — no lock-in, no exit fee.",
        "Anyone can build on it. A documented, read-write API means the next great tool doesn't need anyone's permission.",
        "The roadmap follows real clinics, not a sales quota. Features ship because a practice needed them.",
        "Trust is inspectable. The code is public. You can see exactly what happens to a patient record.",
      ] },
      { type: "p", text: "OpenVPM is our attempt to prove this can exist and be good — not a stripped-down toy, but a modern PIMS with a real API that a clinic could actually run. It's MIT licensed and it always will be." },
      { type: "p", text: "We don't think we have all the answers. We think the answers come faster in the open. If you run a clinic, build in this space, or just have opinions about how it should work, we want them — the harder the better." },
    ],
  },
  {
    slug: "own-your-data-a-second-pims-you-control",
    title: "Own your data: a second PIMS you control",
    date: "June 3, 2026",
    author: "Evan Gauer",
    excerpt:
      "You don't have to rip out the system you run today to start owning your data. Connect a second PIMS — one you control — alongside it.",
    readingMinutes: 5,
    content: [
      { type: "p", text: "The most common reaction we hear from practices is some version of: \"I love the idea, but changing my PIMS is a nightmare I'm not signing up for.\" That's not resistance — it's wisdom. A PIMS migration is one of the riskiest things a clinic can do. So we stopped asking for one." },
      { type: "h2", text: "The model: connect, don't switch" },
      { type: "p", text: "Instead of rip-and-replace, picture a second PIMS that runs alongside the one you already use — and that you fully own. You connect it with an API key, your data flows in, and now you have a live, exportable copy of your practice's records in a system you control. No migration weekend. No retraining the front desk. Your incumbent keeps doing its job while you quietly gain leverage over your own data." },
      { type: "ul", items: [
        "Attach your existing PIMS by API key and mirror your records into a system you own.",
        "Build on the open API — reminders, analytics, AI agents — without asking a vendor for permission.",
        "Export everything, anytime. The whole point is that leaving is always easy.",
        "When you're ready, run it as your primary. Or never. The choice stays yours.",
      ] },
      { type: "h2", text: "Where this goes" },
      { type: "p", text: "The near-term is self-hostable and open: clone it, run it, connect it. The next step is making it effortless — a hosted option where a clinic logs in, attaches their current system, and watches their owned copy populate, no DevOps required. Same open core underneath; we just run the boring parts for you." },
      { type: "quote", text: "Owning your data shouldn't require a migration. It should require an API key." },
      { type: "p", text: "This is the part we're actively building, and it's where outside input matters most. If your PIMS has an API we should mirror, tell us. If it doesn't, tell us that too — that's a story worth telling." },
    ],
  },
  {
    slug: "agents-belong-in-the-back-office",
    title: "Agents belong in the back office, not just the chat box",
    date: "June 3, 2026",
    author: "Evan Gauer",
    excerpt:
      "The exciting thing about AI in veterinary medicine isn't a chatbot on the website. It's an agent that can actually do the busywork — if the PIMS lets it.",
    readingMinutes: 4,
    content: [
      { type: "p", text: "Most \"AI for vets\" right now is a chat box bolted onto a website. It can answer questions. What it can't do is the thing that would actually help a short-staffed clinic: the work. Surface the patients overdue for vaccines. Draft the recall list. Look up a weight-based dose. Find the open slot and book the visit. That work lives inside the PIMS — and an agent can only do it if the PIMS has a real, write-capable API." },
      { type: "h2", text: "Why the closed PIMS blocks this" },
      { type: "p", text: "An agent is only as useful as the tools it can call. If the system of record won't let software write back — create the appointment, record the note, update the record — then the agent is stuck reading. That's the wall most veterinary AI hits today. It's not a model problem. It's an access problem." },
      { type: "h2", text: "What we're building" },
      { type: "p", text: "OpenVPM ships with an agent that operates on the practice's own data through the same open API any developer can use. It works through typed tools — find a client, pull a clinical summary, calculate a dose, find an open slot, book it — and every write is gated for a human to confirm. It's scoped to a single practice and fully inspectable, because it's open source." },
      { type: "ul", items: [
        "Tools, not guesses — the agent acts on real records or it doesn't act.",
        "Human-in-the-loop on every write. The clinic stays in control.",
        "Bring your own model key. Nothing is hidden; the whole thing is auditable.",
      ] },
      { type: "p", text: "We think the clinics that win the next decade won't be the ones with the fanciest chatbot. They'll be the ones whose software lets them put the boring, repetitive work on autopilot — safely. That requires an open foundation. So we're building one." },
    ],
  },
];

export function getPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}
