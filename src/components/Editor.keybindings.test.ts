import {describe,it,expect} from "vitest";
import {editorKeyBindings} from "./Editor";

describe("host editor keybindings",()=>{
  it("leaves native Qt undo, redo and search to remappable application shortcuts",()=>{
    const keys=editorKeyBindings("qt").map(binding=>binding.key).filter(Boolean);
    expect(keys).not.toContain("Mod-z");
    expect(keys).not.toContain("Mod-y");
    expect(keys).not.toContain("Mod-Shift-z");
    expect(keys).not.toContain("Mod-f");
    expect(keys).toContain("Mod-a");
    expect(keys).toContain("ArrowLeft");
    expect(keys).toContain("Enter");
  });

  it("keeps the ordinary editor history and search bindings on Android and web",()=>{
    for(const host of ["android","desktop",undefined]){
      const keys=editorKeyBindings(host).map(binding=>binding.key).filter(Boolean);
      expect(keys).toContain("Mod-z");
      expect(keys).toContain("Mod-f");
    }
  });
});
