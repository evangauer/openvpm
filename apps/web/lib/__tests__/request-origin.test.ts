import { describe, expect, it } from "vitest";
import {
  externallyVisibleRequestOrigin,
  isSameOriginRequest,
} from "../request-origin";

describe("request origin validation", () => {
  it("uses Host and forwarded protocol across a reverse proxy", () => {
    const request = new Request("http://internal-next:3000/api/portal/session", {
      headers: {
        host: "portal.example.test",
        "x-forwarded-proto": "https",
        origin: "https://portal.example.test",
      },
    });

    expect(externallyVisibleRequestOrigin(request)).toBe(
      "https://portal.example.test",
    );
    expect(isSameOriginRequest(request)).toBe(true);
  });

  it("does not trust a spoofed forwarded host over Host", () => {
    const request = new Request("https://internal-next/api/portal/session", {
      headers: {
        host: "portal.example.test",
        "x-forwarded-host": "attacker.example",
        origin: "https://attacker.example",
      },
    });

    expect(externallyVisibleRequestOrigin(request)).toBe(
      "https://portal.example.test",
    );
    expect(isSameOriginRequest(request)).toBe(false);
  });

  it("allows requests without Origin for non-browser clients", () => {
    const request = new Request("https://portal.example.test/api/portal/session");
    expect(isSameOriginRequest(request)).toBe(true);
  });
});
