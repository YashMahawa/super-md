// @vitest-environment jsdom
import {createElement,useState} from "react";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {getSearchQuery} from "@codemirror/search";
import {EditorView} from "@codemirror/view";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import ReadingSearch,{readingMatches,replaceSourceMatches,resolveSourceHighlightRange,sourceMatches} from "./components/ReadingSearch";
import Editor,{editorFindQuery} from "./components/Editor";
import LiveEditor from "./components/LiveEditor";
import {registerWindowedText,windowedMatches} from "./windowedSearch";

(globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;

class MockHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges=ranges;
  }
}

describe("source search",()=>{
  let mountedRoot: Root|null=null;
  let hostContainer: HTMLDivElement|null=null;
  const highlights=new Map<string,MockHighlight>();

  beforeEach(()=>{
    highlights.clear();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    Element.prototype.scrollIntoView=vi.fn();
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>{
      return window.setTimeout(()=>cb(performance.now()),0);
    });
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
  });

  afterEach(()=>{
    if(mountedRoot){
      act(()=>mountedRoot!.unmount());
      mountedRoot=null;
    }
    hostContainer?.remove();
    hostContainer=null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const flushFrames=async()=>{
    await act(async()=>{
      await new Promise(resolve=>setTimeout(resolve,15));
      await new Promise(resolve=>setTimeout(resolve,15));
    });
  };

  it("finds offscreen source, preserves case and literal punctuation",()=>{
    const content="A.b\n"+"long note\n".repeat(3000)+"a.B";
    expect(sourceMatches(content,"a.b")).toEqual([{from:0,to:3},{from:content.length-3,to:content.length}]);
    expect(sourceMatches(content,"A.b",true)).toEqual([{from:0,to:3}]);
  });
  it("replaces literal text, not replacement dollar expressions or regex",()=>{
    expect(replaceSourceMatches("$x$ and $X$","$x$","$1 \\alpha",false,1)).toBe("$x$ and $1 \\alpha");
    expect(replaceSourceMatches("same SAME same","same","new",true)).toBe("new SAME new");
  });

  it("supports whole-word, regex, zero-length progression, and invalid regex safety across search engines",()=>{
    const content="cat category bobcat Cat\nélan élanx\n## Heading One\n## Heading Two";
    expect(sourceMatches(content,"cat",{wholeWord:true})).toEqual([{from:0,to:3},{from:20,to:23}]);
    expect(sourceMatches(content,"cat",{wholeWord:true,caseSensitive:true})).toEqual([{from:0,to:3}]);
    expect(sourceMatches(content,"élan",{wholeWord:true})).toEqual([{from:24,to:28}]);
    expect(sourceMatches(content,"^##\\s+\\w+",{regexp:true}).length).toBe(2);
    expect(sourceMatches("aba","a*",{regexp:true})).toEqual([{from:0,to:1},{from:2,to:3}]);
    expect(sourceMatches("line 1\nline 2","^",{regexp:true})).toEqual([]);
    expect(sourceMatches(content,"[unclosed",{regexp:true})).toEqual([]);
    expect(sourceMatches(content,")(?:",{regexp:true,wholeWord:true})).toEqual([]);

    const dom=document.createElement("article");
    dom.innerHTML="<p>cat category bobcat</p><p>item-12 and item-99</p>";
    expect(readingMatches(dom,"cat",{wholeWord:true}).map(r=>r.toString())).toEqual(["cat"]);
    expect(readingMatches(dom,"item-(\\d+)",{regexp:true}).map(r=>r.toString())).toEqual(["item-12","item-99"]);
    expect(readingMatches(dom,"[unclosed",{regexp:true})).toEqual([]);

    const windowedHost=document.createElement("div");
    const blockA=document.createElement("section");
    blockA.setAttribute("data-windowed-block","");
    windowedHost.append(blockA);
    document.body.append(windowedHost);
    const unregister=registerWindowedText(blockA,"cat category item-42");
    expect(windowedMatches(windowedHost,"cat",{wholeWord:true})).toEqual([{element:blockA,ordinal:0}]);
    expect(windowedMatches(windowedHost,"item-\\d+",{regexp:true})).toEqual([{element:blockA,ordinal:0}]);
    expect(windowedMatches(windowedHost,"a*",{regexp:true})).toEqual([{element:blockA,ordinal:0},{element:blockA,ordinal:1}]);
    expect(windowedMatches(windowedHost,"*invalid",{regexp:true})).toEqual([]);
    unregister();
  });

  it("expands capture groups only in regex mode while preserving LaTeX commands",()=>{
    expect(replaceSourceMatches("x_1 + x_2","x_(\\d+)","\\alpha_$1",{regexp:true})).toBe("\\alpha_1 + \\alpha_2");
    expect(replaceSourceMatches("Ada Lovelace","(?<first>\\w+)\\s+(?<last>\\w+)","$<last>, $<first> ($$1 = $&)",{regexp:true})).toBe("Lovelace, Ada ($1 = Ada Lovelace)");
    expect(replaceSourceMatches("foo bar foo","foo","$1 $$",{regexp:false})).toBe("$1 $$ bar $1 $$");
    expect(replaceSourceMatches("unchanged","[broken","x",{regexp:true})).toBe("unchanged");
    expect(replaceSourceMatches("foo",".*","[$&]",{regexp:true})).toBe("[foo]");
  });

  it("passes wholeWord, regexp, and literal: !regexp to CodeMirror SearchQuery",async()=>{
    hostContainer=document.createElement("div");
    document.body.append(hostContainer);
    mountedRoot=createRoot(hostContainer);
    await act(async()=>{
      mountedRoot!.render(createElement(Editor,{sessionId:"cm-query-test",value:"cat category item-1",onChange:()=>{},dark:false,focusMode:false}));
    });
    const cmDom=hostContainer.querySelector<HTMLElement>(".cm-editor")!;
    const view=EditorView.findFromDOM(cmDom)!;
    editorFindQuery("cm-query-test","item-(\\d+)",true,{wholeWord:true,regexp:true});
    const regexQuery=getSearchQuery(view.state);
    expect(regexQuery.search).toBe("item-(\\d+)");
    expect(regexQuery.caseSensitive).toBe(true);
    expect(regexQuery.wholeWord).toBe(true);
    expect(regexQuery.regexp).toBe(true);
    expect(regexQuery.literal).toBe(false);

    editorFindQuery("cm-query-test","item-(\\d+)",false,{wholeWord:true,regexp:false});
    const literalQuery=getSearchQuery(view.state);
    expect(literalQuery.wholeWord).toBe(true);
    expect(literalQuery.regexp).toBe(false);
    expect(literalQuery.literal).toBe(true);
  });

  it("scrolls Live blocks, opens details, skips hidden link URLs, keeps match across replace toggles, and advances sequential Replace",async()=>{
    const initial="Read [Guide](https://example.com/target) and target one.\n\n> [!QUESTION]- Collapsed section\n> Hidden target two.\n\nFinal target three.";
    let latestContent=initial;
    function Harness(){
      const [text,setText]=useState(initial);
      latestContent=text;
      return createElement("div",{className:"android-document mode-live"},
        createElement(ReadingSearch,{content:text,close:()=>{},onChange:setText}),
        createElement("section",{className:"android-reading"},
          createElement(LiveEditor,{markdown:text,onChange:setText,documentPath:null,python:"embedded",dark:false})
        )
      );
    }
    hostContainer=document.createElement("div");
    document.body.append(hostContainer);
    mountedRoot=createRoot(hostContainer);
    await act(async()=>{mountedRoot!.render(createElement(Harness));});
    await flushFrames();

    // Open an active LiveEditor draft on the last block to ensure replacement closes it cleanly.
    const editableBlocks=hostContainer.querySelectorAll<HTMLElement>(".live-block");
    await act(async()=>{
      editableBlocks[editableBlocks.length-1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));
    });
    expect(hostContainer.querySelector(".live-active-block textarea")).not.toBeNull();

    const searchInput=hostContainer.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    const setNativeValue=(el:HTMLInputElement,val:string)=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,val);
      el.dispatchEvent(new Event("input",{bubbles:true}));
    };
    await act(async()=>{setNativeValue(searchInput,"target");});
    await flushFrames();

    const output=hostContainer.querySelector(".reading-search output")!;
    // In rendered reading mode before Replace is toggled, hidden link URL is excluded (3 visible matches, though block 3 is currently a textarea so 2 rendered + 4 in source).
    // Close active draft via blur or let Replace close it: first step to visible match 0 ("target" in "and target one.").
    const nextBtn=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("target");

    // Toggle Replace ON: active match must stay on "target" in "and target one." (source index 1 of 4, i.e. "2 / 4") instead of resetting to -1 or jumping to hidden URL!
    const replaceToggle=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    await act(async()=>{replaceToggle.click();});
    await flushFrames();
    expect(output.textContent).toBe("2 / 4");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("target");

    // Toggle Replace OFF and back ON: preserves active match.
    await act(async()=>{replaceToggle.click();});
    await flushFrames();
    expect(output.textContent).not.toContain("0 /");
    await act(async()=>{replaceToggle.click();});
    await flushFrames();
    expect(output.textContent).toBe("2 / 4");

    // Verify hidden link URL (source index 0) skips smd-search-current while scrolling link into view.
    const ranges=sourceMatches(latestContent,"target");
    expect(resolveSourceHighlightRange(hostContainer.querySelector(".android-reading")!,latestContent,ranges,0,"target")).toBeNull();
    expect(resolveSourceHighlightRange(hostContainer.querySelector(".android-reading")!,latestContent,ranges,1,"target")?.toString()).toBe("target");

    // Reset query to test index === -1 Replace protection on hidden link URL.
    await act(async()=>{setNativeValue(searchInput,"target");});
    await flushFrames();
    // Re-enter query change to get index = -1:
    await act(async()=>{setNativeValue(searchInput,"targe");});
    await flushFrames();
    await act(async()=>{setNativeValue(searchInput,"target");});
    await flushFrames();
    expect(output.textContent).toBe("0 / 4");

    const replaceInput=hostContainer.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    await act(async()=>{setNativeValue(replaceInput,"targetted");});
    const replaceBtn=Array.from(hostContainer.querySelectorAll("button")).find(b=>b.textContent==="Replace")!;

    // First Replace click at index === -1 selects match 0 (the hidden URL) without mutating content!
    await act(async()=>{replaceBtn.click();});
    await flushFrames();
    expect(latestContent).toBe(initial);
    expect(output.textContent).toBe("1 / 4");
    expect(highlights.has("smd-search-current")).toBe(false);

    // Step to match 1 ("target" in "and target one.") and sequentially Replace!
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(output.textContent).toBe("2 / 4");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("target");

    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    // Replace match 1 with "targetted" (which still contains "target"!). Must advance to match 2 inside closed <details>, open it, scroll, and close the active Live draft!
    await act(async()=>{replaceBtn.click();});
    await flushFrames();
    expect(latestContent).toContain("[Guide](https://example.com/target) and targetted one.");
    expect(hostContainer.querySelector(".live-active-block textarea")).toBeNull();
    expect(output.textContent).toBe("3 / 4");
    const details=hostContainer.querySelector<HTMLDetailsElement>("details.callout")!;
    expect(details.open).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("target");

    // Next sequential Replace replaces match 2 inside callout and advances to match 3 ("Final target three.")!
    await act(async()=>{replaceBtn.click();});
    await flushFrames();
    expect(latestContent).toContain("Hidden targetted two.");
    expect(output.textContent).toBe("4 / 4");

    // Invalid regex shows inline message without throwing and disables Replace.
    const regexToggle=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
    await act(async()=>{regexToggle.click();});
    await act(async()=>{setNativeValue(searchInput,"([unclosed");});
    await flushFrames();
    expect(output.textContent).toBe("Invalid regular expression");
    expect(replaceBtn.disabled).toBe(true);
  });
});
