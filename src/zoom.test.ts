import { describe, expect, it } from "vitest";
import { clampPreviewZoom, previewLayoutWidth, zoomShortcut } from "./zoom";

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

  it("reflows a zoomed page inside its pane instead of clipping it", () => {
    expect(previewLayoutWidth(600, 880, 200)).toBe(284);
    expect(previewLayoutWidth(1200, 880, 100)).toBe(880);
    expect(previewLayoutWidth(320, 880, 240) * 2.4).toBeCloseTo(288);
  });
});
