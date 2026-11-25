import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import { AppErrorView } from "../app-error-view";

describe("AppErrorView", () => {
  it("keeps app error pages addressable by the root skip link", () => {
    const markup = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        timeZone: "UTC",
        children: createElement(AppErrorView, {
          error: new Error("boom"),
          reset: () => undefined,
          source: "app-error",
        }),
      }),
    );

    expect(markup).toContain("<main");
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-labelledby="app-error-title"');
    expect(markup).toContain("Something went wrong");
    expect(markup).toContain("Try Again");
  });
});
