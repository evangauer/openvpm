import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentNotConfiguredError, isAgentConfigured } from "../runner";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAgentConfigured (provider-agnostic)", () => {
  it("a Gemini model is configured only with a non-blank Google API key", () => {
    vi.stubEnv("AI_MODEL", " gemini-2.5-flash ");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test"); // wrong provider's key
    expect(isAgentConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_API_KEY", " AIza-test ");
    expect(isAgentConfigured()).toBe(true);
  });

  it("falls back to the legacy Google Generative AI key when GOOGLE_API_KEY is blank", () => {
    vi.stubEnv("AI_MODEL", "google/gemini-2.5-flash");
    vi.stubEnv("GOOGLE_API_KEY", "   ");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-fallback");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(isAgentConfigured()).toBe(true);
  });

  it("names the Gemini fallback key in the not-configured error", () => {
    expect(new AgentNotConfiguredError().message).toContain(
      "GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY for Gemini"
    );
  });

  it("a Claude model is configured only with a non-blank Anthropic API key", () => {
    vi.stubEnv("AI_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    vi.stubEnv("GOOGLE_API_KEY", "AIza-test"); // wrong provider's key
    expect(isAgentConfigured()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", " sk-ant-test ");
    expect(isAgentConfigured()).toBe(true);
  });

  it("defaults to Claude when AI_MODEL/AGENT_MODEL are blank", () => {
    vi.stubEnv("AI_MODEL", " ");
    vi.stubEnv("AGENT_MODEL", "   ");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(isAgentConfigured()).toBe(true);
  });

  it("trims the legacy AGENT_MODEL fallback before choosing the provider", () => {
    vi.stubEnv("AI_MODEL", "");
    vi.stubEnv("AGENT_MODEL", " google/gemini-2.5-flash ");
    vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(isAgentConfigured()).toBe(true);
  });

  it("rethrows stale-practice tool failures instead of returning them to the model", () => {
    const source = readFileSync(new URL("../runner.ts", import.meta.url), "utf8");

    expect(source).toContain("AgentPracticeNotFoundError");
    expect(source).toContain("e instanceof AgentPracticeNotFoundError");
    expect(source).toContain("throw e");
  });
});
