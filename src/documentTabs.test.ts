import { describe, expect, it } from "vitest";
import { addTab, closeTab, editTab, initialWorkspace, isDirty, markTabSaved, openTab, readWorkspace, restoreClosedTab } from "./documentTabs";

describe("document tabs", () => {
  it("opens files without replacing an edited note and deduplicates by path", () => {
    const initial = initialWorkspace("first");
    const edited = editTab(initial, initial.activeId, "important unsaved note");
    const opened = openTab(edited, { path: "/notes/second.md", content: "second" });
    expect(opened.tabs).toHaveLength(2);
    expect(opened.tabs[0].content).toBe("important unsaved note");
    expect(isDirty(opened.tabs[0])).toBe(true);
    expect(openTab(opened, { path: "/notes/second.md", content: "stale disk copy" }).tabs).toHaveLength(2);
  });

  it("keeps edits made while an earlier revision was saving", () => {
    const initial = initialWorkspace("a");
    const edited = editTab(initial, initial.activeId, "newer");
    const saved = markTabSaved(edited, edited.activeId, "/notes/a.smd", "a");
    expect(saved.tabs[0].content).toBe("newer");
    expect(isDirty(saved.tabs[0])).toBe(true);
  });

  it("closes and reopens a dirty tab without losing content", () => {
    const initial = initialWorkspace();
    const edited = editTab(initial, initial.activeId, "recover me");
    const withAnother = addTab(edited);
    const closed = closeTab(withAnother, initial.activeId);
    expect(closed.tabs).toHaveLength(1);
    const restored = restoreClosedTab(closed);
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs.find((tab) => tab.id === initial.activeId)?.content).toBe("recover me");
  });

  it("restores the saved session and rejects malformed data", () => {
    const state = initialWorkspace("stored");
    const storage = { getItem: () => JSON.stringify(state) };
    expect(readWorkspace(storage, "session", initialWorkspace()).tabs[0].content).toBe("stored");
    expect(readWorkspace({ getItem: () => "{" }, "session", state)).toBe(state);
  });
});
