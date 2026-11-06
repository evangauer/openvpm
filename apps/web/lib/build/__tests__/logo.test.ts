import { describe, expect, it } from "vitest";
import { dominantColor } from "@/lib/build/logo";

function pixels(...colors: Array<[number, number, number, number]>) {
  return new Uint8ClampedArray(colors.flat());
}

describe("dominantColor", () => {
  it("picks the logo's saturated colour, ignoring white, black, grey, and transparency", () => {
    const orange: [number, number, number, number] = [232, 89, 12, 255];
    const data = pixels(
      ...Array(20).fill(orange),
      ...Array(40).fill([255, 255, 255, 255]),
      ...Array(10).fill([10, 10, 10, 255]),
      ...Array(10).fill([128, 128, 128, 255]),
      ...Array(30).fill([0, 120, 255, 0]),
    );
    expect(dominantColor(data)).toBe("#e8590c");
  });

  it("returns null for a monochrome logo", () => {
    expect(dominantColor(pixels(...Array(50).fill([20, 20, 20, 255])))).toBeNull();
  });
});
