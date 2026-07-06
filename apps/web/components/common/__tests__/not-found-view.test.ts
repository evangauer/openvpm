import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotFoundView } from "../not-found-view";

describe("NotFoundView", () => {
  it("renders a branded 404 recovery state", () => {
    const markup = renderToStaticMarkup(createElement(NotFoundView));

    expect(markup).toContain("404");
    expect(markup).toContain("Page not found");
    expect(markup).toContain("This page may have moved");
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Go to Dashboard");
    expect(markup).toContain('id="main-content"');
  });
});
