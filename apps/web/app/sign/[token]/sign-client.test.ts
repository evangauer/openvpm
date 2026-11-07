import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./sign-client.tsx", import.meta.url)),
  "utf8",
);

describe("public consent signing accessibility", () => {
  it("offers keyboard-native signature choices and a labelled typed input", () => {
    expect(source).toContain('<fieldset className="space-y-3">');
    expect(source).toContain("<legend");
    expect(source.match(/type="radio"/g)).toHaveLength(2);
    expect(source).toContain('htmlFor="typed-signature"');
    expect(source).toContain('id="typed-signature"');
    expect(source).toContain('signatureMethod === "typed"');
    expect(source).toContain("signatureMethod,");
  });

  it("converts typed input to a fixed bounded PNG and preserves the drawn pad", () => {
    expect(source).toContain("canvas.width = 900");
    expect(source).toContain("canvas.height = 180");
    expect(source).toContain('canvas.toDataURL("image/png")');
    expect(source).toContain("<SignaturePad onChange={setSignature} />");
  });

  it("posts the receipt credential only in a body to a static endpoint", () => {
    expect(source).toContain('fetch("/api/sign/receipt"');
    expect(source).toContain("body: JSON.stringify({ receiptToken })");
    expect(source).toContain('anchor.download = "signed-consent.pdf"');
    expect(source).not.toContain("?receiptToken=");
  });
});
