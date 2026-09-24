import { describe, expect, it } from "vitest";
import { clampPreviewZoom, zoomShortcut } from "./zoom";

describe("preview zoom", () => {
  it("clamps zoom into a readable range", () => {
    expect(clampPreviewZoom(12)).toBe(60);
    expect(clampPreviewZoom(500)).toBe(240);
    expect(clampPreviewZoom(Number.NaN)).toBe(100);
  });

  it("recognizes common keyboard and numpad shortcuts", () => {
    expect(zoomShortcut({ ctrlKey: true, metaKey: false, altKey: false, code: "Equal", key: "+" })).toBe("in");
    expect(zoomShortcut({ ctrlKey: false, metaKey: true, altKey: false, code: "Minus", key: "-" })).toBe("out");
    expect(zoomShortcut({ ctrlKey: true, metaKey: false, altKey: false, code: "Digit0", key: "0" })).toBe("reset");
  });
});
