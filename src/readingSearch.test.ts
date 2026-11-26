// @vitest-environment jsdom
import {createElement,useState} from "react";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {getSearchQuery} from "@codemirror/search";
import {EditorView} from "@codemirror/view";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import ReadingSearch,{nextSearchIndex,readingMatches,replaceSourceMatches,resolveSourceBlock,resolveSourceHighlightRange,sourceMatches} from "./components/ReadingSearch";
import Editor,{editorFindQuery} from "./components/Editor";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
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

  const setNativeValue=(el:HTMLInputElement,val:string)=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,val);
    el.dispatchEvent(new Event("input",{bubbles:true}));
  };

  it("steps search indices cleanly across 0 / N and wraparound boundaries",()=>{
    expect(nextSearchIndex(-1,1,0)).toBe(-1);
    expect(nextSearchIndex(-1,1,4)).toBe(0);
    expect(nextSearchIndex(-1,-1,4)).toBe(3);
    expect(nextSearchIndex(0,-1,4)).toBe(3);
    expect(nextSearchIndex(3,1,4)).toBe(0);
  });

  it("finds offscreen source, preserves case and literal punctuation",()=>{
    const content="A.b\n"+"long note\n".repeat(3000)+"a.B";
    expect(sourceMatches(content,"a.b")).toEqual([{from:0,to:3},{from:content.length-3,to:content.length}]);
    expect(sourceMatches(content,"A.b",true)).toEqual([{from:0,to:3}]);
  });

  it("replaces literal text, not replacement dollar expressions or regex",()=>{
    expect(replaceSourceMatches("$x$ and $X$","$x$","$1 \\alpha",false,1)).toBe("$x$ and $1 \\alpha");
    expect(replaceSourceMatches("same SAME same","same","new",true)).toBe("new SAME new");
    expect(replaceSourceMatches("a+b a+b a+b","a+b","$&",false,0)).toBe("$& a+b a+b");
    expect(replaceSourceMatches("unchanged","","x")).toBe("unchanged");
  });
  it("wraps backward from unselected 0/N state directly to N/N and steps forward to 1/N",()=>{
    expect(nextSearchIndex(-1,-1,5)).toBe(4);
    expect(nextSearchIndex(-1,1,5)).toBe(0);
    expect(nextSearchIndex(0,-1,5)).toBe(4);
    expect(nextSearchIndex(4,1,5)).toBe(0);
    expect(nextSearchIndex(-1,-1,1)).toBe(0);
    expect(nextSearchIndex(-1,-1,0)).toBe(-1);
  });

  it("supports whole-word, regex, zero-length progression, frontmatter exclusion, and invalid regex safety",()=>{
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
    dom.innerHTML='<section data-frontmatter-properties class="document-properties"><h1 data-frontmatter-field="title">Study Note</h1><dl><dt>Author</dt><dd data-frontmatter-field="author">Ada</dd><dt>Date</dt><dd>cat item-00</dd><dt>Tags</dt><dd><span data-frontmatter-field="tag">cat</span><span data-frontmatter-field="tag">dog</span></dd></dl></section><p>cat category bobcat</p><p>item-12 and item-99</p>';
    expect(readingMatches(dom,"cat",{wholeWord:true}).map(r=>r.toString())).toEqual(["cat","cat"]);
    expect(readingMatches(dom,"catdog")).toEqual([]);
    expect(readingMatches(dom,"Author")).toEqual([]);
    expect(readingMatches(dom,"item-(\\d+)",{regexp:true}).map(r=>r.toString())).toEqual(["item-12","item-99"]);
    expect(readingMatches(dom,"[unclosed",{regexp:true})).toEqual([]);

    const windowedHost=document.createElement("div");
    const fmHeader=document.createElement("section");
    fmHeader.className="document-properties";
    fmHeader.setAttribute("data-frontmatter-properties","");
    fmHeader.innerHTML='<h1 data-frontmatter-field="title">cat study</h1><dl><dt>Author</dt><dd data-frontmatter-field="author">Ada</dd><dt>Date</dt><dd>cat-hidden item-00</dd><dt>Tags</dt><dd><span data-frontmatter-field="tag">tagA</span><span data-frontmatter-field="tag">tagB</span></dd></dl>';
    const blockA=document.createElement("section");
    blockA.setAttribute("data-windowed-block","");
    windowedHost.append(fmHeader,blockA);
    document.body.append(windowedHost);
    const unregister=registerWindowedText(blockA,"cat category item-42");
    expect(windowedMatches(windowedHost,"cat",{wholeWord:true})).toEqual([{element:fmHeader,ordinal:0},{element:blockA,ordinal:0}]);
    expect(windowedMatches(windowedHost,"tagAtagB")).toEqual([]);
    expect(windowedMatches(windowedHost,"Author")).toEqual([]);
    expect(windowedMatches(windowedHost,"item-\\d+",{regexp:true})).toEqual([{element:blockA,ordinal:0}]);
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

  it("keeps Read mode strictly immutable, includes displayed metadata in Find, maps body matches across YAML frontmatter, opens >12-line code disclosures, and yields Escape to modal overlays",async()=>{
    const codeLines=Array.from({length:14},(_,i)=>i===12?"const alpha = 42;":`const row_${i} = ${i};`).join("\n");
    const initial=`---\ntitle: Alpha Study\ndescription: Hidden alpha summary\n---\n\nBody Alpha paragraph.\n\n\`\`\`ts\n${codeLines}\n\`\`\``;
    const onClose=vi.fn();
    let setReadMode!:(read:boolean)=>void;
    function ModeHarness(){
      const [text,setText]=useState(initial);
      const [readOnly,setReadOnly]=useState(true);
      setReadMode=setReadOnly;
      return createElement("div",{className:`android-document mode-${readOnly?"reader":"live"}`},
        createElement(ReadingSearch,{content:text,close:onClose,onChange:readOnly?undefined:setText,initialReplace:true}),
        createElement("section",{className:"android-reading"},
          readOnly
            ? createElement(MarkdownPreview,{markdown:text,documentPath:null,python:"embedded",dark:false})
            : createElement(LiveEditor,{markdown:text,onChange:setText,documentPath:null,python:"embedded",dark:false})
        )
      );
    }
    hostContainer=document.createElement("div");
    document.body.append(hostContainer);
    mountedRoot=createRoot(hostContainer);
    await act(async()=>{mountedRoot!.render(createElement(ModeHarness));});
    await flushFrames();

    // Read mode (onChange undefined) hides Replace in source even when initialReplace=true or supermd-find-focus requests replace.
    expect(hostContainer.querySelector('button[aria-label="Replace in source"]')).toBeNull();
    expect(hostContainer.querySelector(".search-replace")).toBeNull();
    await act(async()=>{
      window.dispatchEvent(new CustomEvent("supermd-find-focus",{detail:{replace:true}}));
    });
    expect(hostContainer.querySelector(".search-replace")).toBeNull();

    const searchInput=hostContainer.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    await act(async()=>{setNativeValue(searchInput,"alpha");});
    await flushFrames();
    const output=hostContainer.querySelector(".reading-search output")!;
    // Displayed title "Alpha Study" + body + code block have 3 rendered matches; description is excluded.
    expect(output.textContent).toBe("0 / 3");

    // Step to match 1 (displayed title -> 1 / 3), then match 2 (Body Alpha paragraph -> 2 / 3), then switch to Live mode and toggle Replace ON -> maps across hidden description to 3 / 4!
    const nextBtn=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(output.textContent).toBe("1 / 3");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Alpha");
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(output.textContent).toBe("2 / 3");

    await act(async()=>{setReadMode(false);});
    await flushFrames();
    const replaceToggle=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    expect(replaceToggle).not.toBeNull();
    await act(async()=>{replaceToggle.click();});
    await flushFrames();
    expect(output.textContent).toBe("3 / 4");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Alpha");

    // Step to match 4 / 4 inside the >12-line collapsed code-disclosure -> opens details.code-disclosure and highlights "alpha"!
    const codeDisclosure=hostContainer.querySelector<HTMLDetailsElement>("details.code-disclosure")!;
    expect(codeDisclosure.open).toBe(false);
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(output.textContent).toBe("4 / 4");
    expect(codeDisclosure.open).toBe(true);
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("alpha");

    // Switching back to Read mode while Replace is open closes Replace and maps 4 / 4 back to rendered 3 / 3!
    await act(async()=>{setReadMode(true);});
    await flushFrames();
    expect(hostContainer.querySelector('button[aria-label="Replace in source"]')).toBeNull();
    expect(hostContainer.querySelector(".search-replace")).toBeNull();
    expect(output.textContent).toBe("3 / 3");

    // Escape yields when a modal overlay (.image-viewer) is mounted, then closes ReadingSearch once removed.
    const modal=document.createElement("div");
    modal.className="image-viewer";
    document.body.append(modal);
    await act(async()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
    expect(onClose).not.toHaveBeenCalled();
    modal.remove();
    await act(async()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("scrolls Live blocks, opens details, skips hidden link URLs, gates Replace at 0 / N, and advances sequential Replace",async()=>{
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
    await act(async()=>{setNativeValue(searchInput,"target");});
    await flushFrames();

    const output=hostContainer.querySelector(".reading-search output")!;
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

    // Verify hidden link URL (source index 0) skips smd-search-current while visible match 1 resolves cleanly.
    const ranges=sourceMatches(latestContent,"target");
    expect(resolveSourceHighlightRange(hostContainer.querySelector(".android-reading")!,latestContent,ranges,0,"target")).toBeNull();
    expect(resolveSourceHighlightRange(hostContainer.querySelector(".android-reading")!,latestContent,ranges,1,"target")?.toString()).toBe("target");

    // Re-enter query change to get 0 / 4 (index = -1) and verify single Replace is disabled while Replace all is enabled.
    await act(async()=>{setNativeValue(searchInput,"targe");});
    await flushFrames();
    await act(async()=>{setNativeValue(searchInput,"target");});
    await flushFrames();
    expect(output.textContent).toBe("0 / 4");

    const replaceInput=hostContainer.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    await act(async()=>{setNativeValue(replaceInput,"targetted");});
    const replaceBtn=Array.from(hostContainer.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="Replace")!;
    const replaceAllBtn=Array.from(hostContainer.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="Replace all")!;
    expect(replaceBtn.disabled).toBe(true);
    expect(replaceAllBtn.disabled).toBe(false);

    // Step to match 0 (1 / 4, hidden link URL): smd-search-current stays clear while Replace becomes enabled.
    await act(async()=>{nextBtn.click();});
    await flushFrames();
    expect(output.textContent).toBe("1 / 4");
    expect(highlights.has("smd-search-current")).toBe(false);
    expect(replaceBtn.disabled).toBe(false);

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

    // Invalid regex shows inline message without throwing and disables Replace and Replace all.
    const regexToggle=hostContainer.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
    await act(async()=>{regexToggle.click();});
    await act(async()=>{setNativeValue(searchInput,"([unclosed");});
    await flushFrames();
    expect(output.textContent).toBe("Invalid regular expression");
    expect(replaceBtn.disabled).toBe(true);
    expect(replaceAllBtn.disabled).toBe(true);
  });

  it("preserves bracketed code matches on <pre data-source-start> owners and steps immediately on first-frame F3",async()=>{
    const raw="```ts\nconst item = list[0](target);\n```";
    const host=document.createElement("div");
    host.className="android-reading";
    host.innerHTML=`<div class="live-block" data-source-start="0" data-source-end="${raw.length}"><div class="code-container" data-source-start="0" data-source-end="${raw.length}"><details class="code-disclosure" open><summary>ts</summary><pre data-source-start="6" data-source-end="${raw.length-4}"><code>const item = list[0](target);\n</code></pre></details></div></div>`;
    document.body.append(host);
    const ranges=sourceMatches(raw,"target");
    expect(ranges).toHaveLength(1);
    expect(resolveSourceBlock(host,ranges[0])?.tagName).toBe("PRE");
    expect(resolveSourceHighlightRange(host,raw,ranges,0,"target")?.toString()).toBe("target");

    // Fallback fence bounds when .code-container has no data-source-start/end attributes and <details> lacks data-source-start.
    host.innerHTML=`<div class="code-container"><details class="code-disclosure"><summary>ts</summary><pre data-source-start="6" data-source-end="${raw.length-4}"><code>const item = list[0](target);\n</code></pre></details></div>`;
    expect(resolveSourceHighlightRange(host,raw,ranges,0,"target")?.toString()).toBe("target");

    // Inline HTML tags (#86 <mark>/<sub>/<sup>/<kbd>) are treated as hidden syntax spans so visible ordinals stay aligned.
    const studyRaw="<mark>mark</mark> and ==mark==.";
    host.innerHTML=`<p data-source-start="0" data-source-end="${studyRaw.length}"><mark>mark</mark> and <mark class="md-highlight">mark</mark>.</p>`;
    const studyRanges=sourceMatches(studyRaw,"mark");
    expect(studyRanges).toHaveLength(4);
    expect(resolveSourceHighlightRange(host,studyRaw,studyRanges,0,"mark")).toBeNull();
    expect(resolveSourceHighlightRange(host,studyRaw,studyRanges,1,"mark")?.startContainer.parentElement?.tagName).toBe("MARK");
    expect(resolveSourceHighlightRange(host,studyRaw,studyRanges,2,"mark")).toBeNull();
    expect(resolveSourceHighlightRange(host,studyRaw,studyRanges,3,"mark")?.startContainer.parentElement?.classList.contains("md-highlight")).toBe(true);
    host.remove();

    hostContainer=document.createElement("div");
    hostContainer.innerHTML='<div class="android-reading"><p>First needle and second needle.</p></div>';
    document.body.append(hostContainer);
    const p=hostContainer.querySelector("p")!;
    const selRange=document.createRange();
    selRange.setStart(p.firstChild!,6);
    selRange.setEnd(p.firstChild!,12);
    const sel=window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(selRange);

    const searchHost=document.createElement("div");
    hostContainer.prepend(searchHost);
    mountedRoot=createRoot(searchHost);
    await act(async()=>{
      mountedRoot!.render(createElement(ReadingSearch,{content:"First needle and second needle.",close:()=>{}}));
    });
    await act(async()=>{
      window.dispatchEvent(new CustomEvent("supermd-find-step",{detail:1}));
    });
    await flushFrames();
    expect(searchHost.querySelector(".reading-search output")?.textContent).toBe("1 / 2");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("needle");
    sel.removeAllRanges();

    // Seeded cross-note handoff resets regex/whole-word filters to literal mode and auto-selects match 1 / N even when Replace is active.
    act(()=>mountedRoot!.unmount());
    hostContainer.querySelector(".android-reading")!.innerHTML='<p data-source-start="0" data-source-end="25">First a+b and second A+B.</p>';
    mountedRoot=createRoot(searchHost);
    await act(async()=>{
      mountedRoot!.render(createElement(ReadingSearch,{content:"First a+b and second A+B.",close:()=>{},onChange:()=>{},initialReplace:true,seed:{query:"a+b",caseSensitive:false,nonce:1}}));
    });
    await flushFrames();
    expect(searchHost.querySelector(".reading-search output")?.textContent).toBe("1 / 2");
    await act(async()=>{
      searchHost.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!.click();
    });
    await flushFrames();
    await act(async()=>{
      mountedRoot!.render(createElement(ReadingSearch,{content:"First a+b and second A+B.",close:()=>{},onChange:()=>{},initialReplace:true,seed:{query:"A+B",caseSensitive:true,nonce:2}}));
    });
    await flushFrames();
    expect(searchHost.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(searchHost.querySelector(".reading-search output")?.textContent).toBe("1 / 1");
  });
});
