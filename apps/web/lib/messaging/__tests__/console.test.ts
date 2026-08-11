import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleProvider } from "../console";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("console messaging provider", () => {
  it("returns a unique accepted id for every local send", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = {
      to: "+15555550199",
      body: "Local test",
      sender: {},
    };

    const first = await consoleProvider.send(input);
    const second = await consoleProvider.send(input);

    expect(first).toMatchObject({ status: "accepted" });
    expect(second).toMatchObject({ status: "accepted" });
    expect(first.status === "accepted" && first.id).toMatch(
      /^dev-console:[0-9a-f-]{36}$/,
    );
    expect(second.status === "accepted" && second.id).not.toBe(
      first.status === "accepted" ? first.id : undefined,
    );
    expect(log).toHaveBeenCalledWith("[SMS] console_provider_accept", {
      bodyLength: "Local test".length,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("+15555550199");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Local test");
  });
});
