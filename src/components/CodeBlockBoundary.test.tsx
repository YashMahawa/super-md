// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import CodeBlockBoundary from "./CodeBlockBoundary";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("contains a block failure and recovers when the source changes", () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never { throw new Error("Invalid diagram"); }
  try {
    act(() => root.render(<><p>Unaffected paragraph</p><CodeBlockBoundary key="bad" source="bad"><Broken /></CodeBlockBoundary></>));
    expect(host.textContent).toContain("Unaffected paragraph"); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("bad");
    act(() => root.render(<CodeBlockBoundary key="fixed" source="fixed"><p>Working diagram</p></CodeBlockBoundary>));
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).toBe("Working diagram");
  } finally { act(() => root.unmount()); host.remove(); consoleError.mockRestore(); }
});
