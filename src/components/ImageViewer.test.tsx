// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ImageViewer, { inlineDiagramDataUrl } from "./ImageViewer";
import MarkdownPreview from "./MarkdownPreview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  document.body.innerHTML = "";
});

describe("ImageViewer standalone diagrams and zoom reset controls", () => {
  it("opens standalone smd-diagram and smd-tree figures as safe SVG data URLs and resets zoom via Fit, double-click, and double-tap", async () => {
    const diagram = JSON.stringify({
      title: "Traversal graph",
      width: 360,
      height: 180,
      nodes: [
        { id: "a", label: "A", x: 90, y: 90, state: "active" },
        { id: "b", label: "B", x: 270, y: 90 }
      ],
      edges: [{ from: "a", to: "b", dashed: true }]
    });
    const tree = JSON.stringify({ title: "Min heap", values: ["2", "5", "8"] });
    const markdown = `\`\`\`smd-diagram\n${diagram}\n\`\`\`\n\n\`\`\`smd-tree\n${tree}\n\`\`\``;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<><ImageViewer /><MarkdownPreview markdown={markdown} documentPath={null} python="" dark /></>));

    const svgs = host.querySelectorAll<SVGSVGElement>(".markdown-body .inline-diagram svg");
    expect(svgs).toHaveLength(2);
    expect(inlineDiagramDataUrl(svgs[0])).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);

    // Click standalone smd-diagram SVG.
    await act(async () => { svgs[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Image viewer"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("header strong")?.textContent).toBe("Traversal graph");
    const img = dialog.querySelector<HTMLImageElement>(".image-viewer-canvas img")!;
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const decodedSvg = decodeURIComponent(img.getAttribute("src")!.split(",")[1]);
    expect(decodedSvg).toContain('width="360"');
    expect(decodedSvg).toContain('height="180"');
    expect(decodedSvg).not.toContain("<script");
    expect(new DOMParser().parseFromString(decodedSvg, "image/svg+xml").querySelector("parsererror")).toBeNull();

    // Zoom with keyboard shortcut and reset with Fit button.
    const zoomOutput = dialog.querySelector<HTMLElement>('output[aria-label="Image zoom"]')!;
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(zoomOutput.textContent).toBe("110%");
    const fitButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>("footer button")).find(b => b.textContent === "Fit")!;
    expect(fitButton).toBeTruthy();
    await act(async () => { fitButton.click(); });
    expect(zoomOutput.textContent).toBe("100%");

    // Zoom again and reset via double-click on .image-viewer-canvas.
    const canvas = dialog.querySelector<HTMLElement>(".image-viewer-canvas")!;
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(zoomOutput.textContent).toBe("110%");
    await act(async () => { canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    expect(zoomOutput.textContent).toBe("100%");

    // Zoom again and reset via double-tap on .image-viewer-canvas.
    await act(async () => { window.dispatchEvent(new CustomEvent("supermd-image-zoom", { detail: 1.5 })); });
    expect(zoomOutput.textContent).toBe("150%");
    await act(async () => {
      for (let tap = 0; tap < 2; tap++) {
        const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
        Object.assign(down, { pointerId: 1, clientX: 120, clientY: 100, pointerType: "touch" });
        canvas.dispatchEvent(down);
        const up = new Event("pointerup", { bubbles: true }) as PointerEvent;
        Object.assign(up, { pointerId: 1, clientX: 122, clientY: 101, pointerType: "touch" });
        canvas.dispatchEvent(up);
      }
    });
    expect(zoomOutput.textContent).toBe("100%");

    // Close and verify smd-tree also opens in ImageViewer.
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]')!.click(); });
    expect(host.querySelector('[role="dialog"][aria-label="Image viewer"]')).toBeNull();
    await act(async () => { svgs[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    expect(host.querySelector('[role="dialog"][aria-label="Image viewer"] header strong')?.textContent).toBe("Min heap");
  });
});
