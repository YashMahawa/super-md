import {describe,it,expect} from "vitest";
import {editorKeyBindings} from "./Editor";

describe("host editor keybindings",()=>{
  it("leaves native Qt undo, redo, search and formatting to remappable application shortcuts",()=>{
    const keys=editorKeyBindings("qt").map(binding=>binding.key).filter(Boolean);
    expect(keys).not.toContain("Mod-z");
    expect(keys).not.toContain("Mod-y");
    expect(keys).not.toContain("Mod-Shift-z");
    expect(keys).not.toContain("Mod-f");
    expect(keys).not.toContain("Mod-b");
    expect(keys).not.toContain("Mod-i");
    expect(keys).not.toContain("Mod-e");
    expect(keys).not.toContain("Mod-k");
    expect(keys).not.toContain("Mod-Shift-h");
    expect(keys).not.toContain("Mod-Shift-l");
    expect(keys).not.toContain("Mod-Shift-q");
    expect(keys).not.toContain("Mod-Shift-m");
    expect(keys).toContain("Mod-a");
    expect(keys).toContain("ArrowLeft");
    expect(keys).toContain("Enter");
  });

  it("keeps the ordinary editor history, search and Markdown formatting bindings on Android and web",()=>{
    for(const host of ["android","desktop",undefined]){
      const keys=editorKeyBindings(host).map(binding=>binding.key).filter(Boolean);
      expect(keys).toContain("Mod-z");
      expect(keys).toContain("Mod-f");
      expect(keys).toContain("Mod-b");
      expect(keys).toContain("Mod-i");
      expect(keys).toContain("Mod-e");
      expect(keys).toContain("Mod-`");
      expect(keys).toContain("Mod-k");
      expect(keys).toContain("Mod-Shift-h");
      expect(keys).toContain("Mod-Shift-l");
      expect(keys).toContain("Mod-Shift-q");
      expect(keys).toContain("Mod-Shift-m");
    }
  });
});
