import { describe, expect, it } from "vitest";
import { sampleFor, sampleTotal, servicesFor, type BuildState } from "@/components/build/scenes";

function draft(services = servicesFor("mobile")): BuildState {
  return { practiceType: "mobile", currentSystem: "paper", clinicName: "Test clinic", brandColor: "#0d9488", logo: null, services };
}

describe("personalized build payment sample", () => {
  it("uses edited prices and excludes disabled services throughout the sample", () => {
    const original = draft();
    const initial = sampleFor(original);
    const selected = initial.charges[0]!;
    const disabled = initial.charges[1]!;
    const edited = draft(original.services.map(service => ({ ...service,
      price: service.name === selected.label ? 135 : service.price,
      on: service.name !== disabled.label,
    })));
    const charges = sampleFor(edited).charges;
    expect(charges.find(line => line.label === selected.label)?.price).toBe(135);
    expect(charges.some(line => line.label === disabled.label)).toBe(false);
    expect(sampleTotal(edited)).toBe(charges.reduce((sum, line) => sum + line.price, 0));
    expect(sampleFor(original)).toEqual(initial);
  });

  it("uses actual custom services without inventing catalog charges", () => {
    const custom = draft([{ name: "Custom exam", price: 123.45, on: true }, { name: "Disabled", price: 99, on: false }]);
    expect(sampleFor(custom).charges).toEqual([{ label: "Custom exam", price: 123.45 }]);
    expect(sampleTotal(custom)).toBe(123.45);
    expect(sampleFor(draft([])).charges).toEqual([]);
  });
});
