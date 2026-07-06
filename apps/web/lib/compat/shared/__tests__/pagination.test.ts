import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
  parsePagination,
} from "../pagination";

function parse(query: string) {
  return parsePagination(new URLSearchParams(query));
}

describe("parsePagination", () => {
  it("uses safe defaults for missing or invalid values", () => {
    expect(parse("")).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
    expect(parse("limit=wat&offset=wat")).toEqual({
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
    expect(parse("limit=-1&offset=-1")).toEqual({
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it("floors positive decimals and caps oversized values", () => {
    expect(parse("limit=10.9&offset=42.8")).toEqual({
      limit: 10,
      offset: 42,
    });
    expect(parse(`limit=1000000&offset=${MAX_OFFSET + 1}`)).toEqual({
      limit: MAX_LIMIT,
      offset: MAX_OFFSET,
    });
  });
});
