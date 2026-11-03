import { describe, expect, it } from "vitest";
import { searchEntries } from "./content";
import { buildIndex, search, terms } from "./search";

const index = buildIndex(searchEntries());
const top = (query: string) => search(index, query)[0]?.entry.href;

describe("search", () => {
  it("folds plurals and verb endings", () => {
    expect(terms("Refunds booking vaccines")).toEqual(["refund", "book", "vaccine"]);
  });

  it.each([
    ["refund", "/guides/refund-or-adjust-a-payment"],
    ["take a payment", "/guides/take-a-payment"],
    ["book a recurring visit", "/guides/book-an-appointment"],
    ["record a vaccine", "/guides/record-a-vaccine"],
    ["invite a teammate", "/guides/invite-and-manage-staff"],
    ["controlled substances", "/screens/controlled-substances"],
    ["inventory", "/screens/inventory"],
    ["vaccine reminder", "/screens/recalls"],
    ["stripe", "/guides/set-up-client-card-payments"],
    ["pay later", "/guides/place-a-balance-in-accounts-receivable"],
  ])("finds “%s”", (query, href) => {
    expect(top(query)).toBe(href);
  });

  it("returns nothing for an empty or filler-only query", () => {
    expect(search(index, "")).toEqual([]);
    expect(search(index, "how do I")).toEqual([]);
  });
});
