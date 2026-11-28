// @vitest-environment jsdom
import {createElement,useState} from "react";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {getSearchQuery} from "@codemirror/search";
import {EditorView} from "@codemirror/view";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import ReadingSearch,{foldUnicodeForSearch,isValidSeedOccurrence,nextSearchIndex,readingMatches,replaceSourceMatches,resolveSourceBlock,resolveSourceHighlightRange,sourceMatches} from "./components/ReadingSearch";
import {findMatchingSourceRangeIndex,hiddenSpansInSlice,insertDomRangeInOrder,markdownBracketEnd,markdownLinkTailEnd,rangeStartElement,syncSearchHighlights,translateRenderedIndexToSource,translateSourceIndexToRendered} from "./readingSearchDom";
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
    expect(windowedMatches(blockA,"a*",{regexp:true})).toEqual([{element:blockA,ordinal:0},{element:blockA,ordinal:1}]);
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

describe("DOM-order windowed search and hidden subtree pruning",()=>{
  it("uses DOM order directly for mounted blocks after out-of-order re-registration and at the 5,000-match cap without compareDocumentPosition",()=>{
    const host=document.createElement("div");
    const otherHost=document.createElement("div");
    const a=document.createElement("section");
    const b=document.createElement("section");
    const c=document.createElement("section");
    const foreign=document.createElement("section");
    for(const el of [a,b,c,foreign])el.setAttribute("data-windowed-block","");
    host.append(a,b,c);
    otherHost.append(foreign);

    const cleanups=[
      registerWindowedText(a,"token tokens alpha item-1"),
      registerWindowedText(b,"token beta token item-20"),
      registerWindowedText(c,"token gamma item-300"),
      registerWindowedText(foreign,"token outside item-999"),
    ];
    // Simulate editing block `a` in Live mode so its registration moves after `b` and `c`.
    cleanups.push(registerWindowedText(a,"token tokens edited-first item-1"));

    const compareSpy=vi.spyOn(Node.prototype,"compareDocumentPosition");
    expect(windowedMatches(host,"token",{wholeWord:true})).toEqual([
      {element:a,ordinal:0},
      {element:b,ordinal:0},
      {element:b,ordinal:1},
      {element:c,ordinal:0},
    ]);
    expect(windowedMatches(host,"item-\\d+",{regexp:true})).toEqual([
      {element:a,ordinal:0},
      {element:b,ordinal:0},
      {element:c,ordinal:0},
    ]);
    expect(compareSpy).not.toHaveBeenCalled();

    // Verify 5,000-match cap still truncates in true DOM order even when `a` was re-registered last.
    cleanups.push(registerWindowedText(b,"hit ".repeat(3000)));
    cleanups.push(registerWindowedText(c,"hit ".repeat(3000)));
    cleanups.push(registerWindowedText(a,"hit ".repeat(10)));
    const capped=windowedMatches(host,"hit",{wholeWord:true})!;
    expect(capped).toHaveLength(5000);
    expect(capped[0]).toEqual({element:a,ordinal:0});
    expect(capped[9]).toEqual({element:a,ordinal:9});
    expect(capped[10]).toEqual({element:b,ordinal:0});
    expect(capped[3009]).toEqual({element:b,ordinal:2999});
    expect(capped[3010]).toEqual({element:c,ordinal:0});
    expect(compareSpy).not.toHaveBeenCalled();

    compareSpy.mockRestore();
    cleanups.forEach(fn=>fn());
  });

  it("skips hidden, inert, offstage, unmounted, MathML, and control subtrees while preserving visible KaTeX HTML and closed details disclosures",()=>{
    const host=document.createElement("article");
    host.className="markdown-body";
    host.innerHTML=[
      '<div data-frontmatter-properties="true"><span>needle-1 frontmatter</span></div>',
      '<p>needle-1 needles-1 visible</p>',
      '<p><span class="katex"><span class="katex-html" aria-hidden="true"><span class="mord">needle-2</span></span><span class="katex-mathml"><math><semantics><mrow><mi>needle-2</mi></mrow><annotation encoding="application/x-tex">needle-2</annotation></semantics></math></span></span></p>',
      '<details class="callout"><summary>Summary</summary><p>needle-3 in closed callout</p></details>',
      '<div class="step-cards-figure is-offstage" aria-hidden="true" inert=""><p>needle-4 offstage</p></div>',
      '<section data-windowed-block="" data-windowed-mounted="false"><span>needle-5 unmounted</span></section>',
      '<p hidden>needle-6 hidden-attr</p>',
      '<p inert>needle-7 inert-attr</p>',
      '<span aria-hidden="true">needle-8 aria-hidden</span>',
      '<span style="display: none">needle-9 display-none</span>',
      '<span style="visibility: hidden">needle-10 visibility-hidden</span>',
      '<svg><text>needle-11 svg</text></svg>',
      '<button type="button">needle-12 button</button>',
      '<iframe>needle-13 iframe</iframe>',
      '<script>const needle = "needle-14";</script>',
      '<style>.needle-15 { color: red; }</style>',
    ].join("");

    const hits=readingMatches(host,"needle-\\d+",{regexp:true,wholeWord:true});
    expect(hits.map(r=>r.toString())).toEqual(["needle-1","needle-2","needle-3"]);
    expect(hits[0].startContainer.parentElement?.tagName).toBe("P");
    expect(hits[1].startContainer.parentElement?.closest(".katex-html")).not.toBeNull();
    expect(hits[2].startContainer.parentElement?.closest("details.callout")).not.toBeNull();

    // Block boundaries still prevent false cross-paragraph matches.
    const boundary=document.createElement("div");
    boundary.innerHTML="<p>foo</p><p>bar</p><li>item <p>nested</p> end</li>";
    expect(readingMatches(boundary,"foobar")).toEqual([]);
    expect(readingMatches(boundary,"itemnested")).toEqual([]);
    expect(readingMatches(boundary,"nestedend")).toEqual([]);
  });

  it("benchmarks DOM-order windowed search and dense hidden-subtree pruning without compareDocumentPosition",()=>{
    const windowedHost=document.createElement("div");
    const cleanups:Array<()=>void>=[];
    const blocks:HTMLElement[]=[];
    for(let i=0;i<1000;i++){
      const section=document.createElement("section");
      section.setAttribute("data-windowed-block","");
      section.setAttribute("data-windowed-mounted",i<24?"true":"false");
      if(i<24){
        section.innerHTML=`<h2>Chapter ${i}</h2><p>Readable chapter ${i} with Readable prose and <span class="katex"><span class="katex-html" aria-hidden="true"><span class="mord">Readable</span></span><span class="katex-mathml"><math><semantics><mrow><mi>Readable</mi></mrow><annotation>Readable</annotation></semantics></math></span></span></p>`;
      }else{
        section.innerHTML='<span aria-hidden="true"></span>';
      }
      windowedHost.append(section);
      blocks.push(section);
    }
    // Register in scrambled Live-edit order so legacy registration order differs from DOM tree order.
    for(let i=blocks.length-1;i>=0;i--){
      cleanups.push(registerWindowedText(blocks[i],`Chapter ${i}\nReadable chapter ${i} with Readable prose and Readable\n`));
    }

    const compareSpy=vi.spyOn(Node.prototype,"compareDocumentPosition");
    const t0=performance.now();
    const wHits=windowedMatches(windowedHost,"Readable",{wholeWord:true})!;
    const windowedMs=performance.now()-t0;
    expect(wHits).toHaveLength(3000);
    expect(wHits[0]).toEqual({element:blocks[0],ordinal:0});
    expect(wHits[3]).toEqual({element:blocks[1],ordinal:0});
    expect(wHits[2999]).toEqual({element:blocks[999],ordinal:2});
    expect(compareSpy).not.toHaveBeenCalled();

    const t1=performance.now();
    const domHits=readingMatches(windowedHost,"Readable",{wholeWord:true});
    const domMs=performance.now()-t1;
    // 24 mounted blocks * 3 visible "Readable" tokens (duplicate .katex-mathml and 976 unmounted blocks pruned).
    expect(domHits).toHaveLength(72);
    expect(windowedMs).toBeGreaterThanOrEqual(0);
    expect(domMs).toBeGreaterThanOrEqual(0);

    compareSpy.mockRestore();
    cleanups.forEach(fn=>fn());
  });

  it("shares a bounded source-range index across repeated source-to-reader mappings and invalidates on document and windowed mount changes",()=>{
    const part0="## Chapter 0\n\nAlpha [doc](https://example.com/Alpha-0) and Alpha one.";
    const part1="## Chapter 1\n\n> [!NOTE]- Folded\n> Alpha two.";
    const part2="## Chapter 2\n\nAlpha three.";
    const content=`${part0}\n\n${part1}\n\n${part2}`;
    const s0=0,e0=part0.length;
    const s1=e0+2,e1=s1+part1.length;
    const s2=e1+2,e2=s2+part2.length;

    const scroller=document.createElement("section");
    scroller.className="android-reading";
    const host=document.createElement("article");
    host.className="markdown-body";
    host.innerHTML=[
      `<section class="live-block" data-windowed-block="" data-windowed-mounted="true" data-source-start="${s0}" data-source-end="${e0}">`,
      `  <h2 data-source-start="${s0}" data-source-end="${s0+12}">Chapter 0</h2>`,
      `  <p data-source-start="${s0+14}" data-source-end="${e0}">Alpha <a data-source-start="${s0+20}" data-source-end="${s0+60}" href="https://example.com/Alpha-0">doc</a> and Alpha one.</p>`,
      `</section>`,
      `<section class="live-block" data-windowed-block="" data-windowed-mounted="true" data-source-start="${s1}" data-source-end="${e1}">`,
      `  <h2 data-source-start="${s1}" data-source-end="${s1+12}">Chapter 1</h2>`,
      `  <details class="callout" data-source-start="${s1+14}" data-source-end="${e1}"><summary>Folded</summary><p data-source-start="${s1+32}" data-source-end="${e1}">Alpha two.</p></details>`,
      `</section>`,
      `<section class="live-block" data-windowed-block="" data-windowed-mounted="false" data-source-start="${s2}" data-source-end="${e2}"><span aria-hidden="true"></span></section>`,
    ].join("");
    scroller.append(host);
    document.body.append(scroller);

    const ranges=sourceMatches(content,"Alpha");
    // Ranges: 0 -> visible Alpha in ch0, 1 -> hidden URL Alpha-0, 2 -> visible Alpha one, 3 -> Alpha two in details, 4 -> unmounted ch2 Alpha three.
    expect(ranges).toHaveLength(5);

    const candidateQueries=()=>vi.mocked(Element.prototype.querySelectorAll).mock.calls.filter(([sel])=>String(sel).includes("data-windowed-block")&&String(sel).includes("data-source-start")).length;
    const qsaSpy=vi.spyOn(Element.prototype,"querySelectorAll");

    // Initial lookup builds the index once; 40 repeated source-to-reader mappings reuse it without walking candidates again.
    expect(resolveSourceBlock(scroller,ranges[0],content)?.tagName).toBe("P");
    expect(candidateQueries()).toBe(1);
    for(let i=0;i<20;i++){
      expect(resolveSourceHighlightRange(scroller,content,ranges,0,"Alpha")?.toString()).toBe("Alpha");
      expect(resolveSourceHighlightRange(scroller,content,ranges,1,"Alpha")).toBeNull();
      expect(resolveSourceHighlightRange(scroller,content,ranges,2,"Alpha")?.toString()).toBe("Alpha");
      expect(resolveSourceHighlightRange(scroller,content,ranges,3,"Alpha")?.toString()).toBe("Alpha");
      expect(resolveSourceHighlightRange(scroller,content,ranges,4,"Alpha")).toBeNull();
      expect(resolveSourceBlock(scroller,ranges[4],content)?.getAttribute("data-windowed-mounted")).toBe("false");
    }
    expect(candidateQueries()).toBe(1);

    // Gap fallback (between Chapter 0 and Chapter 1) and cross-block overlapping range use the same index without rescanning.
    expect(resolveSourceBlock(scroller,{from:e0+1,to:e0+1},content)?.tagName).toBe("A");
    expect(resolveSourceBlock(scroller,{from:s0+16,to:s1+10},content)?.tagName).toBe("P");
    expect(candidateQueries()).toBe(1);

    // Non-source mutations (opening <details>, scroller style.height, hover class) do NOT invalidate the index.
    scroller.querySelector("details")!.open=true;
    scroller.style.height="2400px";
    host.firstElementChild!.classList.add("is-hovered");
    expect(resolveSourceHighlightRange(scroller,content,ranges,3,"Alpha")?.toString()).toBe("Alpha");
    expect(candidateQueries()).toBe(1);

    // Windowed mount change (mounting Chapter 2 + supermd-window-change) invalidates and resolves the newly mounted match.
    const block2=scroller.querySelectorAll<HTMLElement>("[data-windowed-block]")[2];
    block2.setAttribute("data-windowed-mounted","true");
    block2.innerHTML=`<h2 data-source-start="${s2}" data-source-end="${s2+12}">Chapter 2</h2><p data-source-start="${s2+14}" data-source-end="${e2}">Alpha three.</p>`;
    scroller.dispatchEvent(new Event("supermd-window-change"));
    expect(resolveSourceBlock(scroller,ranges[4],content)?.tagName).toBe("P");
    expect(resolveSourceHighlightRange(scroller,content,ranges,4,"Alpha")?.toString()).toBe("Alpha");
    const afterMountQueries=candidateQueries();
    expect(afterMountQueries).toBe(2);
    // Subsequent lookups reuse the rebuilt post-mount index.
    expect(resolveSourceHighlightRange(scroller,content,ranges,4,"Alpha")?.toString()).toBe("Alpha");
    expect(candidateQueries()).toBe(afterMountQueries);

    // Document content change invalidates cached source spans and rebuilds cleanly.
    const editedContent=content.replace("Alpha three.","Alpha edited.");
    const editedRanges=sourceMatches(editedContent,"Alpha");
    expect(resolveSourceHighlightRange(scroller,editedContent,editedRanges,4,"Alpha")?.toString()).toBe("Alpha");
    expect(candidateQueries()).toBe(afterMountQueries+1);

    // Bounded host cache (>8 distinct hosts) evicts oldest hosts cleanly without breaking lookups when revisited.
    const extraHosts:HTMLElement[]=[];
    for(let h=0;h<10;h++){
      const extra=document.createElement("div");
      extra.innerHTML=`<p data-source-start="0" data-source-end="11">Alpha ${h}</p>`;
      document.body.append(extra);
      extraHosts.push(extra);
      expect(resolveSourceBlock(extra,{from:0,to:5},`Alpha ${h}`)?.tagName).toBe("P");
    }
    expect(resolveSourceHighlightRange(scroller,editedContent,editedRanges,2,"Alpha")?.toString()).toBe("Alpha");

    qsaSpy.mockRestore();
    extraHosts.forEach(el=>el.remove());
    scroller.remove();
  });
});

describe("readingSearchDom ordinal translation and highlight sync",()=>{
  afterEach(()=>{
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("translates ordinals bidirectionally across displayed frontmatter and mounted/unmounted windowed blocks while skipping hidden fields and link URLs",()=>{
    const b0="Read [Guide](https://example.com/hit) and hit alpha.";
    const b1="Unmounted [Ref](https://example.com/hit) first hit and second hit.";
    const fm="---\ntitle: hit frontmatter\ndescription: hidden hit summary\n---\n\n";
    const content=`${fm}${b0}\n\n${b1}`;
    const start0=fm.length,end0=start0+b0.length;
    const start1=end0+2,end1=start1+b1.length;

    const host=document.createElement("div");
    host.className="android-reading";
    const fmHeader=document.createElement("section");
    fmHeader.className="document-properties";
    fmHeader.setAttribute("data-frontmatter-properties","");
    fmHeader.innerHTML='<h1 data-frontmatter-field="title">hit frontmatter</h1>';
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.setAttribute("data-source-start",String(start0));
    s0.setAttribute("data-source-end",String(end0));
    s0.innerHTML=`<p data-source-start="${start0}" data-source-end="${start0}">Read <a href="https://example.com/hit" data-source-start="${start0+5}" data-source-end="${start0+37}">Guide</a> and hit alpha.</p>`.replace(`data-source-end="${start0}"`,`data-source-end="${end0}"`);
    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","false");
    s1.setAttribute("data-source-start",String(start1));
    s1.setAttribute("data-source-end",String(end1));
    s1.innerHTML='<span aria-hidden="true"></span>';
    host.append(fmHeader,s0,s1);
    document.body.append(host);

    const cleanups=[
      registerWindowedText(s0,"Read Guide and hit alpha."),
      registerWindowedText(s1,"Unmounted Ref first hit and second hit."),
    ];
    const ranges=sourceMatches(content,"hit");
    // Source indices: 0=displayed title, 1=hidden description, 2=s0 hidden URL, 3=s0 visible, 4=s1 hidden URL, 5=s1 visible #1, 6=s1 visible #2.
    expect(ranges).toHaveLength(7);
    const wMatches=windowedMatches(host,"hit")!;
    expect(wMatches).toHaveLength(4);

    expect(translateSourceIndexToRendered(host,content,ranges,0,"hit",false,wMatches)).toBe(0);
    expect(translateSourceIndexToRendered(host,content,ranges,1,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,2,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,3,"hit",false,wMatches)).toBe(1);
    expect(translateSourceIndexToRendered(host,content,ranges,4,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,5,"hit",false,wMatches)).toBe(2);
    expect(translateSourceIndexToRendered(host,content,ranges,6,"hit",false,wMatches)).toBe(3);

    expect(translateRenderedIndexToSource(host,content,ranges,0,"hit",false,wMatches)).toBe(0);
    expect(translateRenderedIndexToSource(host,content,ranges,1,"hit",false,wMatches)).toBe(3);
    expect(translateRenderedIndexToSource(host,content,ranges,2,"hit",false,wMatches)).toBe(5);
    expect(translateRenderedIndexToSource(host,content,ranges,3,"hit",false,wMatches)).toBe(6);
    expect(translateRenderedIndexToSource(host,content,ranges,9,"hit",false,wMatches)).toBe(-1);
    cleanups.forEach(fn=>fn());
  });

  it("synchronizes CSS.highlights selectively and refreshes active highlight on supermd-window-change",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));

    const host=document.createElement("div");
    host.className="android-reading";
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","false");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end","11");
    s0.innerHTML='<span aria-hidden="true"></span>';
    const searchRootEl=document.createElement("div");
    host.append(s0);
    document.body.append(searchRootEl,host);
    const cleanup=registerWindowedText(s0,"Alpha token");

    const dummyNode=document.createTextNode("Alpha");
    const r=document.createRange();
    r.setStart(dummyNode,0);
    r.setEnd(dummyNode,5);
    syncSearchHighlights({all:()=>[r],current:()=>r});
    expect(highlights.get("smd-search")?.ranges).toEqual([r]);
    expect(highlights.get("smd-search-current")?.ranges).toEqual([r]);
    // Leaving `all` undefined preserves smd-search while clearing smd-search-current.
    syncSearchHighlights({current:null});
    expect(highlights.has("smd-search")).toBe(true);
    expect(highlights.has("smd-search-current")).toBe(false);
    syncSearchHighlights({all:null,current:null});
    expect(highlights.size).toBe(0);

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{content:"Alpha token",close:()=>{},onChange:()=>{},initialReplace:true,seed:{query:"Alpha",nonce:1}}));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
    expect(highlights.get("smd-search")?.ranges).toHaveLength(0);
    expect(highlights.has("smd-search-current")).toBe(false);

    // Simulate virtualized block mounting into viewport and firing supermd-window-change.
    s0.setAttribute("data-windowed-mounted","true");
    s0.innerHTML='<p data-source-start="0" data-source-end="11">Alpha token</p>';
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    const firstAllHighlight=highlights.get("smd-search");
    const firstCurrentHighlight=highlights.get("smd-search-current");
    expect(firstAllHighlight?.ranges.map(x=>x.toString())).toEqual(["Alpha"]);
    expect(firstCurrentHighlight?.ranges.map(x=>x.toString())).toEqual(["Alpha"]);

    // Repeated window-change or style-height extent updates without rendered match changes reuse cached ranges and Highlight instances.
    s0.style.height="480px";
    const cachedRef=readingMatches(host,"Alpha");
    expect(readingMatches(host,"Alpha")).toBe(cachedRef);
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(highlights.get("smd-search")).toBe(firstAllHighlight);
    expect(highlights.get("smd-search-current")).toBe(firstCurrentHighlight);

    // Visibility mutation (display: none) invalidates cached matches immediately.
    s0.style.display="none";
    expect(readingMatches(host,"Alpha")).toEqual([]);

    cleanup();
    act(()=>root.unmount());
  });

  it("settles windowed Read matches across layout shifts without redundant highlight churn and cancels on manual scroll keys",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    const scrollTargets:Element[]=[];
    let scrollHeight=8000,scrollTop=0;
    Element.prototype.scrollIntoView=function(){
      scrollTargets.push(this);
      scrollTop=3200;
    };

    const host=document.createElement("div");
    host.className="android-reading";
    Object.defineProperty(host,"scrollHeight",{configurable:true,get:()=>scrollHeight});
    Object.defineProperty(host,"scrollTop",{configurable:true,get:()=>scrollTop,set:(v:number)=>{scrollTop=v;}});
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.innerHTML="<p>Needle zero</p>";
    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","false");
    s1.innerHTML='<span aria-hidden="true"></span>';
    s1.addEventListener("supermd-reveal-window",()=>{
      s1.setAttribute("data-windowed-mounted","true");
      s1.innerHTML="<p>Needle distant</p>";
    });
    const searchRootEl=document.createElement("div");
    host.append(s0,s1);
    document.body.append(searchRootEl,host);
    const cleanups=[registerWindowedText(s0,"Needle zero"),registerWindowedText(s1,"Needle distant")];

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{content:"Needle zero\n\nNeedle distant",close:()=>{}}));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
    const searchInput=searchRootEl.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(searchInput,"Needle");
    await act(async()=>{searchInput.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});

    const nextBtn=searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    await act(async()=>{nextBtn.click();});
    await act(async()=>{nextBtn.click();});
    expect(s1.getAttribute("data-windowed-mounted")).toBe("true");
    const syncedAll=highlights.get("smd-search");
    const syncedCurrent=highlights.get("smd-search-current");
    expect(syncedCurrent?.ranges[0]?.toString()).toBe("Needle");

    // Drain initial settle frames: Highlight objects are reused while rendered DOM has not mutated.
    await act(async()=>{
      for(let i=0;i<5;i++)await new Promise(resolve=>requestAnimationFrame(()=>resolve(undefined)));
    });
    expect(highlights.get("smd-search")).toBe(syncedAll);
    expect(highlights.get("smd-search-current")).toBe(syncedCurrent);

    // Delayed layout shrinkage re-scrolls active match without rebuilding unchanged highlights.
    scrollTargets.length=0;
    scrollHeight=7400;
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0].textContent).toContain("Needle distant");
    expect(highlights.get("smd-search")).toBe(syncedAll);

    // Manual scroll key outside .reading-search cancels settle immediately.
    scrollTargets.length=0;
    await act(async()=>{
      host.dispatchEvent(new KeyboardEvent("keydown",{key:"PageDown",bubbles:true}));
      scrollHeight=6900;
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollTargets).toHaveLength(0);

    cleanups.forEach(fn=>fn());
    act(()=>root.unmount());
  });

  it("maps displayed frontmatter metadata across BOM, out-of-order, quoted, folded, flow, and duplicate source spans while preserving regex replacement semantics",()=>{
    const content=[
      "\uFEFF---",
      'description: "hidden needle"',
      "tags: [needle, alpha, needle]",
      "authors:",
      "  - >",
      "    Ada",
      "    needle",
      'title: "needle \\"one\\""',
      "---",
      "Body needle.",
    ].join("\n");
    const bodyStart=content.indexOf("Body needle.");
    const host=document.createElement("div");
    host.className="android-reading";
    const props=document.createElement("header");
    props.className="document-properties";
    props.setAttribute("data-frontmatter-properties","");
    props.innerHTML=[
      '<h1 data-frontmatter-field="title">needle "one"</h1>',
      '<span data-frontmatter-field="author">Ada needle</span>',
      '<span data-frontmatter-field="secret">hidden needle</span>',
      '<span data-frontmatter-field="tag">needle</span>',
      '<span data-frontmatter-field="tag">alpha</span>',
    ].join("");
    const bodyP=document.createElement("p");
    bodyP.setAttribute("data-source-start",String(bodyStart));
    bodyP.setAttribute("data-source-end",String(content.length));
    bodyP.textContent="Body needle.";
    host.append(props,bodyP);

    const ranges=sourceMatches(content,"needle");
    // Source indices: 0=hidden description, 1=first flow tag, 2=duplicate flow tag (deduplicated in DOM), 3=folded author, 4=quoted title, 5=body.
    expect(ranges).toHaveLength(6);

    // Calling resolveSourceHighlightRange before connecting host must not poison connected calls.
    const preConnect=resolveSourceHighlightRange(host,content,ranges,4,"needle");
    document.body.append(host);
    const postConnect=resolveSourceHighlightRange(host,content,ranges,4,"needle");
    expect(preConnect?.toString()).toBe("needle");
    expect(postConnect?.startContainer.isConnected).toBe(true);

    // Rendered DOM order is title (source 4), author (source 3), tag (source 1), body (source 5); hidden secret & deduplicated tag #2 do not map.
    const domMatches=readingMatches(host,"needle");
    expect(domMatches).toHaveLength(4);
    expect(translateRenderedIndexToSource(host,content,ranges,0,"needle",false,null,domMatches)).toBe(4);
    expect(translateRenderedIndexToSource(host,content,ranges,1,"needle",false,null,domMatches)).toBe(3);
    expect(translateRenderedIndexToSource(host,content,ranges,2,"needle",false,null,domMatches)).toBe(1);
    expect(translateRenderedIndexToSource(host,content,ranges,3,"needle",false,null,domMatches)).toBe(5);
    expect(translateSourceIndexToRendered(host,content,ranges,0,"needle",false,null,domMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,2,"needle",false,null,domMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,4,"needle",false,null,domMatches)).toBe(0);
    expect(translateSourceIndexToRendered(host,content,ranges,3,"needle",false,null,domMatches)).toBe(1);
    expect(translateSourceIndexToRendered(host,content,ranges,1,"needle",false,null,domMatches)).toBe(2);
    expect(translateSourceIndexToRendered(host,content,ranges,5,"needle",false,null,domMatches)).toBe(3);

    // Exact source-span single Replace targets the folded author value without touching hidden description or title.
    const replacedAuthor=replaceSourceMatches(content,"needle","spark",false,3);
    expect(replacedAuthor).toContain('description: "hidden needle"');
    expect(replacedAuthor).toContain("    Ada\n    spark");
    expect(replacedAuthor).toContain('title: "needle \\"one\\""');

    // Overridden inline style -> hidden invalidates cached DOM matches even if oldValue also contained "display: none".
    bodyP.setAttribute("style","display: none; display: block");
    expect(readingMatches(host,"needle")).toHaveLength(4);
    bodyP.setAttribute("style","display: none");
    expect(readingMatches(host,"needle")).toHaveLength(3);

    // Named capture groups replace unknown $<missing> with "" (matching String.prototype.replace), while unnamed regexes preserve literal $<missing>.
    expect(replaceSourceMatches("foo bar","(?<w>foo)","[$<w>:$<missing>]",{regexp:true})).toBe("[foo:] bar");
    expect(replaceSourceMatches("foo bar","(foo)","[$1:$<missing>]",{regexp:true})).toBe("[foo:$<missing>] bar");
  });

  it("preserves Unicode case-folding seed validation, ordered DOM range insertion, and manual host scroll cancellation across extracted modules",async()=>{
    expect(foldUnicodeForSearch("Straße İstanbul ﬁ ﬄ")).toBe("strasse i\u0307stanbul fi ffl");
    const unicodeDoc="📓 Intro — Straße and İstanbul with ﬁnale.";
    const strasseStart=unicodeDoc.indexOf("Straße");
    const istanbulStart=unicodeDoc.indexOf("İstanbul");
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",false,"Straße")).toBe(true);
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",true,"Straße")).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:istanbulStart,to:istanbulStart+8},"i\u0307stanbul",false,"İstanbul")).toBe(true);
    // Reject split UTF-16 surrogate pairs on astral code points (`📓` occupies UTF-16 indices 0..2).
    expect(isValidSeedOccurrence(unicodeDoc,{from:0,to:1},"📓",false)).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:1,to:8},"Intro",false)).toBe(false);
    // Reject stale matchText or out-of-bounds offsets.
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",false,"Strasse")).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:0,to:unicodeDoc.length+2},"strasse",false)).toBe(false);

    // Verify findMatchingSourceRangeIndex and insertDomRangeInOrder helper contracts.
    const sampleRanges=[{from:2,to:5},{from:10,to:14},{from:10,to:16},{from:22,to:28}];
    expect(findMatchingSourceRangeIndex(sampleRanges,{from:10,to:16})).toBe(2);
    expect(findMatchingSourceRangeIndex(sampleRanges,{from:10,to:15})).toBe(-1);

    const container=document.createElement("p");
    container.textContent="alpha Strasse Straße omega";
    const textNode=container.firstChild as Text;
    const mkRange=(s:number,e:number)=>{const r=document.createRange();r.setStart(textNode,s);r.setEnd(textNode,e);return r;};
    const rAlpha=mkRange(0,5),rStrasse=mkRange(14,20),rOmega=mkRange(21,26);
    expect(rangeStartElement(rStrasse)).toBe(container);
    const inserted=insertDomRangeInOrder([rAlpha,rOmega],rStrasse);
    expect(inserted.index).toBe(1);
    expect(inserted.ranges.map(r=>r.toString())).toEqual(["alpha","Straße","omega"]);
    expect(insertDomRangeInOrder(inserted.ranges,mkRange(14,20)).index).toBe(1);

    // Seeded offscreen Unicode-folded match keeps custom highlight across window changes and stops settling on manual host scroll (> 2px).
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    let scrollHeight=6000,scrollTop=0;
    const scrollCalls:Element[]=[];
    Element.prototype.scrollIntoView=function(){
      scrollCalls.push(this);
      scrollTop=2400;
    };

    const host=document.createElement("div");
    host.className="android-reading";
    Object.defineProperty(host,"scrollHeight",{configurable:true,get:()=>scrollHeight});
    Object.defineProperty(host,"scrollTop",{configurable:true,get:()=>scrollTop,set:(v:number)=>{scrollTop=v;}});
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","false");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end",String(unicodeDoc.length));
    s0.innerHTML='<span aria-hidden="true"></span>';
    s0.addEventListener("supermd-reveal-window",()=>{
      s0.setAttribute("data-windowed-mounted","true");
      s0.innerHTML=`<p data-source-start="0" data-source-end="${unicodeDoc.length}">${unicodeDoc}</p>`;
    });
    const searchRootEl=document.createElement("div");
    host.append(s0);
    document.body.append(searchRootEl,host);
    const cleanup=registerWindowedText(s0,unicodeDoc);

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:unicodeDoc,
        close:()=>{},
        seed:{query:"strasse",caseSensitive:false,sourceStart:strasseStart,sourceEnd:strasseStart+6,matchText:"Straße",nonce:1},
      }));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,40));});
    expect(s0.getAttribute("data-windowed-mounted")).toBe("true");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Straße");

    // Window-change preserves customCurrentRangeRef on Unicode-folded occurrence.
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Straße");

    // Manual scroll delta > 2px cancels active settle passes immediately.
    scrollCalls.length=0;
    scrollTop=2450;
    await act(async()=>{
      host.dispatchEvent(new Event("scroll"));
      scrollHeight=5400;
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollCalls).toHaveLength(0);

    // Unmounting and remounting the windowed block clears detached custom highlight and re-resolves onto the new text node.
    const oldNode=highlights.get("smd-search-current")?.ranges[0]?.startContainer;
    s0.setAttribute("data-windowed-mounted","false");
    s0.innerHTML='<span aria-hidden="true"></span>';
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(highlights.has("smd-search-current")).toBe(false);

    s0.setAttribute("data-windowed-mounted","true");
    s0.innerHTML=`<p data-source-start="0" data-source-end="${unicodeDoc.length}">${unicodeDoc}</p>`;
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    const remountedRange=highlights.get("smd-search-current")?.ranges[0];
    expect(remountedRange?.toString()).toBe("Straße");
    expect(remountedRange?.startContainer.isConnected).toBe(true);
    expect(remountedRange?.startContainer).not.toBe(oldNode);

    cleanup();
    act(()=>root.unmount());
  });

  it("preserves source fallback across windowed unmount/remount cycles and U+00A0 frontmatter spans while sharing the bounded index",()=>{
    const fm=[
      "---",
      "description: \u00A0\"Hidden Symmetry Summary\"",
      "\"title\"\u00A0: \u00A0\"Symmetry Kernel\"",
      "'author'\u00A0: \u00A0[\u00A0{\u00A0\"given\"\u00A0:\u00A0\"Emmy\",\u00A0'family'\u00A0:\u00A0'Symmetry'\u00A0}\u00A0]",
      "\"tags\"\u00A0: \u00A0[Symmetry,\u00A0\u00A0Noether]",
      "---",
      "",
    ].join("\n");
    const ch0="## Chapter 0\n\nSymmetry [link](https://example.com/Symmetry-0) and Symmetry alpha.";
    const ch1="## Chapter 1\n\nSymmetry [ref](https://example.com/Symmetry-1) and Symmetry beta.";
    const content=`${fm}${ch0}\n\n${ch1}`;
    const s0=fm.length,e0=s0+ch0.length;
    const s1=e0+2,e1=s1+ch1.length;

    const host=document.createElement("div");
    host.className="android-reading";
    const props=document.createElement("section");
    props.className="document-properties";
    props.setAttribute("data-frontmatter-properties","");
    props.innerHTML=[
      '<h1 data-frontmatter-field="title">Symmetry Kernel</h1>',
      '<dd data-frontmatter-field="author">Emmy Symmetry</dd>',
      '<span data-frontmatter-field="tag">Symmetry</span>',
      '<span data-frontmatter-field="tag">Noether</span>',
    ].join("");
    const b0=document.createElement("section");
    b0.setAttribute("data-windowed-block","");
    b0.setAttribute("data-windowed-mounted","true");
    b0.setAttribute("data-source-start",String(s0));
    b0.setAttribute("data-source-end",String(e0));
    b0.innerHTML=`<h2 data-source-start="${s0}" data-source-end="${s0+12}">Chapter 0</h2><p data-source-start="${s0+14}" data-source-end="${e0}">Symmetry <a data-source-start="${s0+23}" data-source-end="${s0+61}" href="https://example.com/Symmetry-0">link</a> and Symmetry alpha.</p>`;
    const b1=document.createElement("section");
    b1.setAttribute("data-windowed-block","");
    b1.setAttribute("data-windowed-mounted","true");
    b1.setAttribute("data-source-start",String(s1));
    b1.setAttribute("data-source-end",String(e1));
    b1.innerHTML=`<h2 data-source-start="${s1}" data-source-end="${s1+12}">Chapter 1</h2><p data-source-start="${s1+14}" data-source-end="${e1}">Symmetry <a data-source-start="${s1+23}" data-source-end="${s1+60}" href="https://example.com/Symmetry-1">ref</a> and Symmetry beta.</p>`;
    host.append(props,b0,b1);
    document.body.append(host);

    const cleanups=[
      registerWindowedText(b0,"Chapter 0\nSymmetry link and Symmetry alpha."),
      registerWindowedText(b1,"Chapter 1\nSymmetry ref and Symmetry beta."),
    ];
    const ranges=sourceMatches(content,"Symmetry");
    // Source indices: 0=hidden description, 1=title, 2=author, 3=tag, 4=ch0 visible #1, 5=ch0 hidden URL, 6=ch0 visible #2, 7=ch1 visible #1, 8=ch1 hidden URL, 9=ch1 visible #2.
    expect(ranges).toHaveLength(10);
    const wMatches=windowedMatches(host,"Symmetry")!;
    expect(wMatches).toHaveLength(7);

    // #227 U+00A0 frontmatter spans map accurately alongside mounted body blocks while redacting hidden description (0 -> -1).
    expect(translateSourceIndexToRendered(host,content,ranges,0,"Symmetry",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,1,"Symmetry",false,wMatches)).toBe(0);
    expect(translateSourceIndexToRendered(host,content,ranges,2,"Symmetry",false,wMatches)).toBe(1);
    expect(translateSourceIndexToRendered(host,content,ranges,3,"Symmetry",false,wMatches)).toBe(2);
    expect(translateRenderedIndexToSource(host,content,ranges,0,"Symmetry",false,wMatches)).toBe(1);
    expect(translateRenderedIndexToSource(host,content,ranges,1,"Symmetry",false,wMatches)).toBe(2);
    expect(translateRenderedIndexToSource(host,content,ranges,2,"Symmetry",false,wMatches)).toBe(3);

    const initialCh1Node=resolveSourceHighlightRange(host,content,ranges,9,"Symmetry")?.startContainer;
    expect(initialCh1Node?.textContent).toContain("Symmetry");
    expect(resolveSourceBlock(host,{from:e0+1,to:e0+1},content)?.tagName).toBe("A");

    // 1. Unmount b0 and b1 (simulating scroll offscreen): source fallback uses wrapper [data-source-start] bounds, never detached nodes.
    b0.setAttribute("data-windowed-mounted","false");
    b0.innerHTML='<span aria-hidden="true"></span>';
    b1.setAttribute("data-windowed-mounted","false");
    b1.innerHTML='<span aria-hidden="true"></span>';
    host.dispatchEvent(new Event("supermd-window-change"));

    expect(resolveSourceBlock(host,ranges[9],content)).toBe(b1);
    expect(resolveSourceBlock(host,{from:e0+1,to:e0+1},content)).toBe(b0);
    expect(resolveSourceHighlightRange(host,content,ranges,9,"Symmetry")).toBeNull();
    expect(translateSourceIndexToRendered(host,content,ranges,8,"Symmetry",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,9,"Symmetry",false,wMatches)).toBe(6);
    expect(translateRenderedIndexToSource(host,content,ranges,6,"Symmetry",false,wMatches)).toBe(9);

    // 2. Remount b1 in deferred/loading state (mounted="true" before inner text hydrates) and b0 without inner data-source-start attributes:
    //    source fallback preserves exact ordinal translation in both directions while still skipping hidden link URLs.
    b0.setAttribute("data-windowed-mounted","true");
    b0.innerHTML='<h2>Chapter 0</h2><p>Symmetry <a href="https://example.com/Symmetry-0">link</a> and Symmetry alpha.</p>';
    b1.setAttribute("data-windowed-mounted","true");
    b1.innerHTML='<div class="image-loading">Loading figure...</div>';
    host.dispatchEvent(new Event("supermd-window-change"));

    expect(resolveSourceBlock(host,ranges[6],content)).toBe(b0);
    expect(resolveSourceHighlightRange(host,content,ranges,6,"Symmetry")?.toString()).toBe("Symmetry");
    expect(translateSourceIndexToRendered(host,content,ranges,5,"Symmetry",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,6,"Symmetry",false,wMatches)).toBe(4);
    expect(translateRenderedIndexToSource(host,content,ranges,4,"Symmetry",false,wMatches)).toBe(6);
    // Deferred remounted b1 falls back cleanly to source ordinals without inner text nodes yet.
    expect(translateSourceIndexToRendered(host,content,ranges,7,"Symmetry",false,wMatches)).toBe(5);
    expect(translateSourceIndexToRendered(host,content,ranges,8,"Symmetry",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,9,"Symmetry",false,wMatches)).toBe(6);
    expect(translateRenderedIndexToSource(host,content,ranges,5,"Symmetry",false,wMatches)).toBe(7);
    expect(translateRenderedIndexToSource(host,content,ranges,6,"Symmetry",false,wMatches)).toBe(9);

    // 3. Complete b1 hydration with inner [data-source-start] owners: live Range resolves onto fresh connected node.
    b1.innerHTML=`<h2 data-source-start="${s1}" data-source-end="${s1+12}">Chapter 1</h2><p data-source-start="${s1+14}" data-source-end="${e1}">Symmetry <a data-source-start="${s1+23}" data-source-end="${s1+60}" href="https://example.com/Symmetry-1">ref</a> and Symmetry beta.</p>`;
    const qsaSpy=vi.spyOn(Element.prototype,"querySelectorAll");
    const remountedCh1=resolveSourceHighlightRange(host,content,ranges,9,"Symmetry");
    expect(remountedCh1?.toString()).toBe("Symmetry");
    expect(remountedCh1?.startContainer.isConnected).toBe(true);
    expect(remountedCh1?.startContainer).not.toBe(initialCh1Node);
    const scansAfterHydrate=qsaSpy.mock.calls.filter(([sel])=>String(sel).includes("data-windowed-block")&&String(sel).includes("data-source-start")).length;
    expect(scansAfterHydrate).toBe(1);
    // Repeated translations share the rebuilt index with 0 further candidate scans.
    expect(translateSourceIndexToRendered(host,content,ranges,9,"Symmetry",false,wMatches)).toBe(6);
    expect(translateRenderedIndexToSource(host,content,ranges,6,"Symmetry",false,wMatches)).toBe(9);
    expect(qsaSpy.mock.calls.filter(([sel])=>String(sel).includes("data-windowed-block")&&String(sel).includes("data-source-start")).length).toBe(scansAfterHydrate);

    qsaSpy.mockRestore();
    cleanups.forEach(fn=>fn());
    host.remove();
  });

  it("deduplicates inline delimiter scanning while preserving escape-only link tails, Markdown masking, and exact UTF-16 Unicode ranges",()=>{
    // Bracket labels skip single/multi-backtick code spans (exact run length), escaped brackets, and nested brackets, without pairing inner ticks of unclosed runs.
    const singleCode="[`a]b`](https://example.com)";
    expect(markdownBracketEnd(singleCode,0)).toBe(6);
    const multiCode="[``a ` ] b``](https://example.com)";
    expect(markdownBracketEnd(multiCode,0)).toBe(12);
    const mismatchedInnerTicks="[`a `` ] b`](https://example.com)";
    expect(markdownBracketEnd(mismatchedInnerTicks,0)).toBe(11);
    const unclosedMultiTicks="[``a] ` b](https://example.com)";
    expect(markdownBracketEnd(unclosedMultiTicks,0)).toBe(4);
    const escapedAndNested="[outer \\[skip\\] [inner] end](https://example.com)";
    expect(markdownBracketEnd(escapedAndNested,0)).toBe(escapedAndNested.indexOf("]("));

    // Inline (...) link tails are escape-only: backticks inside URLs do NOT open code spans, while \(, \), \\), and nested (...) balance accurately.
    const backtickUrl="[docs](https://example.com/a`b) visible `code`";
    expect(markdownLinkTailEnd(backtickUrl,6)).toBe(backtickUrl.indexOf(") visible")+1);
    const nestedParenUrl="[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) tail";
    expect(markdownLinkTailEnd(nestedParenUrl,6)).toBe(nestedParenUrl.indexOf(") tail")+1);
    const escapedParenUrl="[esc](https://example.com/foo\\)bar) tail";
    expect(markdownLinkTailEnd(escapedParenUrl,5)).toBe(escapedParenUrl.indexOf(") tail")+1);
    const escapedSlashBeforeClose="[slash](https://example.com/foo\\\\) tail";
    expect(markdownLinkTailEnd(escapedSlashBeforeClose,7)).toBe(escapedSlashBeforeClose.indexOf(") tail")+1);
    // Reference-style [label][ref] link tails still honor backtick code spans via markdownBracketEnd, while non-tails return afterBracket.
    const refTail="[label][`ref]1`] tail";
    expect(markdownLinkTailEnd(refTail,7)).toBe(refTail.indexOf(" tail"));
    expect(markdownLinkTailEnd("[literal] plain",9)).toBe(9);

    // Markdown masking + exact UTF-16 offsets across astral surrogates (`📓`), Unicode case-fold expansions (`Straße`), inline HTML, escape-only backtick URLs, inline code, and images.
    const md="📓 [See <mark>Straße</mark>](https://example.com/Straße`v1) and `[fake](https://visible.example/Straße)` after ![alt Straße](https://img.example/Straße.png).";
    const hidden=hiddenSpansInSlice(md,100);
    const isHidden=(from:number,to:number)=>hidden.some(h=>from>=h.from&&to<=h.to);
    const ranges=sourceMatches(md,"Straße",true);
    // Occurrences of "Straße" in `md`:
    // 0: visible inside <mark>Straße</mark> within link label
    // 1: hidden inside escape-only backtick URL (https://example.com/Straße`v1)
    // 2: visible inside inline code span `[fake](https://visible.example/Straße)`
    // 3: hidden inside image alt ![alt Straße]
    // 4: hidden inside image URL (https://img.example/Straße.png)
    expect(ranges).toHaveLength(5);
    expect(ranges.map(r=>md.slice(r.from,r.to))).toEqual(["Straße","Straße","Straße","Straße","Straße"]);
    expect(isHidden(ranges[0].from+100,ranges[0].to+100)).toBe(false);
    expect(isHidden(ranges[1].from+100,ranges[1].to+100)).toBe(true);
    expect(isHidden(ranges[2].from+100,ranges[2].to+100)).toBe(false);
    expect(isHidden(ranges[3].from+100,ranges[3].to+100)).toBe(true);
    expect(isHidden(ranges[4].from+100,ranges[4].to+100)).toBe(true);
    // Also verify `<mark>` and `</mark>` inside the link label are masked while `and` after the backtick URL remains unmasked.
    const openMark=md.indexOf("<mark>");
    const andWord=md.indexOf("and");
    expect(isHidden(100+openMark,100+openMark+6)).toBe(true);
    expect(isHidden(100+andWord,100+andWord+3)).toBe(false);
  });

  it("preserves distinct reveal behavior on Replace exit between Read-mode transition and manual Replace toggle",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    Element.prototype.scrollIntoView=vi.fn();
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    const flushFrames=async()=>{
      await act(async()=>{
        await new Promise(resolve=>setTimeout(resolve,15));
        await new Promise(resolve=>setTimeout(resolve,15));
      });
    };

    const p0="Alpha needle.";
    const p1="Beta needle.";
    const doc=`${p0}\n\n${p1}`;
    const p1Start=doc.indexOf(p1);
    const host=document.createElement("div");
    host.className="android-reading";
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end",String(p0.length));
    s0.innerHTML=`<p data-source-start="0" data-source-end="${p0.length}">${p0}</p>`;

    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","true");
    s1.setAttribute("data-source-start",String(p1Start));
    s1.setAttribute("data-source-end",String(doc.length));
    const mountS1=()=>{
      s1.setAttribute("data-windowed-mounted","true");
      s1.innerHTML=`<p data-source-start="${p1Start}" data-source-end="${doc.length}">${p1}</p>`;
    };
    const unmountS1=()=>{
      s1.setAttribute("data-windowed-mounted","false");
      s1.innerHTML='<span aria-hidden="true"></span>';
    };
    mountS1();
    let revealCount=0;
    s1.addEventListener("supermd-reveal-window",()=>{
      revealCount++;
      mountS1();
    });
    const searchRootEl=document.createElement("div");
    host.append(s0,s1);
    document.body.append(searchRootEl,host);
    const clean0=registerWindowedText(s0,p0);
    const clean1=registerWindowedText(s1,p1);

    const onChange=vi.fn();
    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        onChange,
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();

    // Open Replace in source and step to 2 / 2 (in s1), then simulate s1 virtualizing offscreen (`data-windowed-mounted="false"`).
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");

    unmountS1();
    revealCount=0;

    // 1. Exiting Replace via `canReplace -> false` (Live -> Read transition, `onChange` omitted) does NOT reveal/mount offscreen s1 (`exitReplacingToRendered(false)`).
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();
    expect(searchRootEl.querySelector(".search-replace")).toBeNull();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(revealCount).toBe(0);
    expect(s1.getAttribute("data-windowed-mounted")).toBe("false");

    // 2. Re-enter Live Replace at 2 / 2 with s1 unmounted, then manually toggle `Replace in source` OFF -> DOES reveal/mount s1 (`exitReplacingToRendered(true)`).
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        onChange,
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(s1.getAttribute("data-windowed-mounted")).toBe("false");

    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector(".search-replace")).toBeNull();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(revealCount).toBe(1);
    expect(s1.getAttribute("data-windowed-mounted")).toBe("true");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("needle");

    clean0();
    clean1();
    act(()=>root.unmount());
  });

  it("bounds hiddenSpansInSlice non-recursively across deeply nested bracket/link markup while preserving exact UTF-16 offsets and escape-only URL tails",()=>{
    // 1. 2,500-deep nested links (~95 KB, well within 200 KB block limit) with astral UTF-16 surrogates (`📓`),
    //    inner `<mark>`, HTML comment, inline code, and escape-only URL tails containing unmatched backticks and escaped `\)`.
    //    Recursive `.slice()` + `...` spread would overflow the call stack or degrade quadratically; stack traversal stays linear & merges adjacent spans.
    const depth=2500;
    const prefix="📓 Intro ";
    const core="See <!-- hidden Straße --><mark>Straße</mark> and `[keep](https://visible.example/Straße)`";
    const tailUnit="](https://example.com/Straße`v1\\)ok)";
    const deepNested=prefix+"[".repeat(depth)+core+tailUnit.repeat(depth)+" 💡 omega";
    const baseOffset=42;
    const hidden=hiddenSpansInSlice(deepNested,baseOffset);
    const isHidden=(from:number,to:number)=>hidden.some(h=>from>=h.from&&to<=h.to);

    // Adjacent `[` openings merge into 1 span, comment+`<mark>` merge into 1 span, `</mark>` stays 1 span, and all 2,500 `](...)` tails merge into 1 span = 4 disjoint sorted spans!
    expect(hidden).toHaveLength(4);
    for(let i=1;i<hidden.length;i++) expect(hidden[i-1].to).toBeLessThan(hidden[i].from);

    // Exact UTF-16 offsets: `📓` occupies 2 UTF-16 code units, so opening `[` run spans `[prefix.length, prefix.length + depth)`.
    expect(hidden[0]).toEqual({from:baseOffset+prefix.length,to:baseOffset+prefix.length+depth});
    const visibleStrasseFrom=deepNested.indexOf("<mark>Straße</mark>")+"<mark>".length;
    const codeStrasseFrom=deepNested.indexOf("visible.example/Straße")+"visible.example/".length;
    const firstTailStrasseFrom=deepNested.indexOf("https://example.com/Straße")+"https://example.com/".length;
    const lastTailStrasseFrom=deepNested.lastIndexOf("Straße");
    const omegaFrom=deepNested.lastIndexOf("omega");
    expect(deepNested.slice(visibleStrasseFrom,visibleStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(codeStrasseFrom,codeStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(firstTailStrasseFrom,firstTailStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(lastTailStrasseFrom,lastTailStrasseFrom+6)).toBe("Straße");
    expect(isHidden(baseOffset+visibleStrasseFrom,baseOffset+visibleStrasseFrom+6)).toBe(false);
    expect(isHidden(baseOffset+codeStrasseFrom,baseOffset+codeStrasseFrom+6)).toBe(false);
    expect(isHidden(baseOffset+firstTailStrasseFrom,baseOffset+firstTailStrasseFrom+6)).toBe(true);
    expect(isHidden(baseOffset+lastTailStrasseFrom,baseOffset+lastTailStrasseFrom+6)).toBe(true);
    expect(isHidden(baseOffset+omegaFrom,baseOffset+omegaFrom+5)).toBe(false);

    // 2. Pathological 25,000 unclosed `[` brackets + badge image-in-link `[![alt](img)](dest)` + unclosed outer `[` before `![alt](img)` + >200 KB guard.
    const unclosedLead="📓 "+"[".repeat(25_000)+"[Visible Straße](https://example.com/Straße`tail) [![Badge Straße](https://img.example/Straße`1.png)](https://dest.example/Straße`2) [unclosed ![Img Straße](https://img.example/Straße`3.png)";
    const unclosedHidden=hiddenSpansInSlice(unclosedLead,10);
    const isUnclosedHidden=(from:number,to:number)=>unclosedHidden.some(h=>from>=h.from&&to<=h.to);
    const unclosedHits=sourceMatches(unclosedLead,"Straße",true);
    // 0: Visible Straße (visible)
    // 1: first link escape-only backtick URL (hidden)
    // 2: badge image alt (hidden)
    // 3: badge image URL (hidden)
    // 4: badge outer link URL (hidden)
    // 5: trailing image alt after unclosed `[` (hidden)
    // 6: trailing image URL after unclosed `[` (hidden)
    expect(unclosedHits).toHaveLength(7);
    expect(unclosedHits.map(r=>isUnclosedHidden(r.from+10,r.to+10))).toEqual([false,true,true,true,true,true,true]);
    expect(isUnclosedHidden(10+2,10+2+25_000)).toBe(false);
    expect(hiddenSpansInSlice("[x](https://example.com)".repeat(9000),0)).toEqual([]);

    // 3. End-to-end `resolveSourceHighlightRange` on a rendered block containing deeply nested links, astral UTF-16 offsets, and escape-only URL tails.
    const blockNested="📓 "+"[".repeat(400)+"Lead <mark>Straße</mark>"+"](https://example.com/Straße`x\\)y)".repeat(400)+" after";
    const host=document.createElement("div");
    host.className="markdown-body";
    host.innerHTML=`<p data-source-start="0" data-source-end="${blockNested.length}">📓 <a href="https://example.com/Straße%60x)y">Lead <mark>Straße</mark></a> after</p>`;
    document.body.append(host);
    const nestedMatches=sourceMatches(blockNested,"straße",false);
    expect(nestedMatches).toHaveLength(401);
    expect(isValidSeedOccurrence(blockNested,nestedMatches[0],"strasse",false,"Straße")).toBe(true);
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,0,"straße",false)?.toString()).toBe("Straße");
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,1,"straße",false)).toBeNull();
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,400,"straße",false)).toBeNull();
    host.remove();
  });

  it("resolves search results after inline SVG class mutations without throwing or rebuilding the source-range index",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    Element.prototype.scrollIntoView=vi.fn();
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    const flushFrames=async()=>{
      await act(async()=>{
        await new Promise(resolve=>setTimeout(resolve,15));
        await new Promise(resolve=>setTimeout(resolve,15));
      });
    };

    const p0="Alpha diagram intro.";
    const p1="Alpha conclusion.";
    const doc=`${p0}\n\n${p1}`;
    const p1Start=doc.indexOf(p1);
    const host=document.createElement("div");
    host.className="android-reading";
    host.innerHTML=[
      `<section class="live-block" data-windowed-block="" data-windowed-mounted="true" data-source-start="0" data-source-end="${p0.length}">`,
      `  <p data-source-start="0" data-source-end="${p0.length}">${p0}</p>`,
      `  <svg viewBox="0 0 16 16" aria-hidden="true"><g><path d="M0 0h16v16H0z"></path></g></svg>`,
      `</section>`,
      `<section class="live-block" data-windowed-block="" data-windowed-mounted="true" data-source-start="${p1Start}" data-source-end="${doc.length}">`,
      `  <p data-source-start="${p1Start}" data-source-end="${doc.length}">${p1}</p>`,
      `</section>`,
    ].join("");
    const searchRootEl=document.createElement("div");
    document.body.append(searchRootEl,host);
    const sections=host.querySelectorAll<HTMLElement>("[data-windowed-block]");
    const clean0=registerWindowedText(sections[0],p0);
    const clean1=registerWindowedText(sections[1],p1);

    const svg=host.querySelector("svg")!;
    const svgPath=svg.querySelector("path")!;
    expect(svg).toBeInstanceOf(SVGElement);
    expect(svg).not.toBeInstanceOf(HTMLElement);
    expect(typeof (svg as Element).className).toBe("object");

    const ranges=sourceMatches(doc,"Alpha");
    expect(ranges).toHaveLength(2);
    // Prime the shared SourceRangeIndex on `host`.
    expect(resolveSourceHighlightRange(host,doc,ranges,0,"Alpha")?.toString()).toBe("Alpha");

    const qsaSpy=vi.spyOn(Element.prototype,"querySelectorAll");
    const candidateScans=()=>qsaSpy.mock.calls.filter(([sel])=>String(sel).includes("data-windowed-block")&&String(sel).includes("data-source-start")).length;

    // 1. Synchronous `observer.takeRecords()` path: mutate `<svg>` and `<path>` classes, then immediately resolve source mappings before microtask flush.
    svg.setAttribute("class","diagram-svg is-zoomed");
    svg.classList.add("live-block");
    svgPath.setAttribute("class","diagram-node is-hovered");
    expect(resolveSourceBlock(host,ranges[0],doc)?.tagName).toBe("P");
    expect(resolveSourceHighlightRange(host,doc,ranges,0,"Alpha")?.toString()).toBe("Alpha");
    expect(resolveSourceHighlightRange(host,doc,ranges,1,"Alpha")?.toString()).toBe("Alpha");
    expect(translateRenderedIndexToSource(host,doc,ranges,1,"Alpha")).toBe(1);
    expect(translateSourceIndexToRendered(host,doc,ranges,1,"Alpha")).toBe(1);
    expect(candidateScans()).toBe(0);

    // 2. Async `MutationObserver` callback + interactive `ReadingSearch` resolution (Find & Replace in source).
    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        onChange:()=>{},
        seed:{query:"Alpha",nonce:1},
      }));
    });
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("1 / 2");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Alpha");

    qsaSpy.mockClear();
    svg.classList.remove("live-block");
    svg.classList.add("is-panning");
    svgPath.classList.toggle("is-selected");
    await Promise.resolve();

    // Toggling `Replace in source` ON and stepping to match 2 / 2 resolves cleanly without throwing or rebuilding the index.
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("1 / 2");

    svg.setAttribute("class","diagram-svg is-settled");
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Alpha");
    expect(candidateScans()).toBe(0);

    // A genuine HTMLElement source-relevant class mutation (`code-container`) still invalidates and rebuilds as expected.
    const extraDiv=document.createElement("div");
    host.firstElementChild!.append(extraDiv);
    resolveSourceBlock(host,ranges[0],doc);
    qsaSpy.mockClear();
    extraDiv.classList.add("code-container");
    expect(resolveSourceHighlightRange(host,doc,ranges,1,"Alpha")?.toString()).toBe("Alpha");
    expect(candidateScans()).toBe(1);

    qsaSpy.mockRestore();
    clean0();
    clean1();
    act(()=>root.unmount());
  });
});

describe("readingSearchDom ordinal translation and highlight sync",()=>{
  afterEach(()=>{
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("translates ordinals bidirectionally across displayed frontmatter and mounted/unmounted windowed blocks while skipping hidden fields and link URLs",()=>{
    const b0="Read [Guide](https://example.com/hit) and hit alpha.";
    const b1="Unmounted [Ref](https://example.com/hit) first hit and second hit.";
    const fm="---\ntitle: hit frontmatter\ndescription: hidden hit summary\n---\n\n";
    const content=`${fm}${b0}\n\n${b1}`;
    const start0=fm.length,end0=start0+b0.length;
    const start1=end0+2,end1=start1+b1.length;

    const host=document.createElement("div");
    host.className="android-reading";
    const fmHeader=document.createElement("section");
    fmHeader.className="document-properties";
    fmHeader.setAttribute("data-frontmatter-properties","");
    fmHeader.innerHTML='<h1 data-frontmatter-field="title">hit frontmatter</h1>';
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.setAttribute("data-source-start",String(start0));
    s0.setAttribute("data-source-end",String(end0));
    s0.innerHTML=`<p data-source-start="${start0}" data-source-end="${start0}">Read <a href="https://example.com/hit" data-source-start="${start0+5}" data-source-end="${start0+37}">Guide</a> and hit alpha.</p>`.replace(`data-source-end="${start0}"`,`data-source-end="${end0}"`);
    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","false");
    s1.setAttribute("data-source-start",String(start1));
    s1.setAttribute("data-source-end",String(end1));
    s1.innerHTML='<span aria-hidden="true"></span>';
    host.append(fmHeader,s0,s1);
    document.body.append(host);

    const cleanups=[
      registerWindowedText(s0,"Read Guide and hit alpha."),
      registerWindowedText(s1,"Unmounted Ref first hit and second hit."),
    ];
    const ranges=sourceMatches(content,"hit");
    // Source indices: 0=displayed title, 1=hidden description, 2=s0 hidden URL, 3=s0 visible, 4=s1 hidden URL, 5=s1 visible #1, 6=s1 visible #2.
    expect(ranges).toHaveLength(7);
    const wMatches=windowedMatches(host,"hit")!;
    expect(wMatches).toHaveLength(4);

    expect(translateSourceIndexToRendered(host,content,ranges,0,"hit",false,wMatches)).toBe(0);
    expect(translateSourceIndexToRendered(host,content,ranges,1,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,2,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,3,"hit",false,wMatches)).toBe(1);
    expect(translateSourceIndexToRendered(host,content,ranges,4,"hit",false,wMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,5,"hit",false,wMatches)).toBe(2);
    expect(translateSourceIndexToRendered(host,content,ranges,6,"hit",false,wMatches)).toBe(3);

    expect(translateRenderedIndexToSource(host,content,ranges,0,"hit",false,wMatches)).toBe(0);
    expect(translateRenderedIndexToSource(host,content,ranges,1,"hit",false,wMatches)).toBe(3);
    expect(translateRenderedIndexToSource(host,content,ranges,2,"hit",false,wMatches)).toBe(5);
    expect(translateRenderedIndexToSource(host,content,ranges,3,"hit",false,wMatches)).toBe(6);
    expect(translateRenderedIndexToSource(host,content,ranges,9,"hit",false,wMatches)).toBe(-1);
    cleanups.forEach(fn=>fn());
  });

  it("synchronizes CSS.highlights selectively and refreshes active highlight on supermd-window-change",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));

    const host=document.createElement("div");
    host.className="android-reading";
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","false");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end","11");
    s0.innerHTML='<span aria-hidden="true"></span>';
    const searchRootEl=document.createElement("div");
    host.append(s0);
    document.body.append(searchRootEl,host);
    const cleanup=registerWindowedText(s0,"Alpha token");

    const dummyNode=document.createTextNode("Alpha");
    const r=document.createRange();
    r.setStart(dummyNode,0);
    r.setEnd(dummyNode,5);
    syncSearchHighlights({all:()=>[r],current:()=>r});
    expect(highlights.get("smd-search")?.ranges).toEqual([r]);
    expect(highlights.get("smd-search-current")?.ranges).toEqual([r]);
    // Leaving `all` undefined preserves smd-search while clearing smd-search-current.
    syncSearchHighlights({current:null});
    expect(highlights.has("smd-search")).toBe(true);
    expect(highlights.has("smd-search-current")).toBe(false);
    syncSearchHighlights({all:null,current:null});
    expect(highlights.size).toBe(0);

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{content:"Alpha token",close:()=>{},onChange:()=>{},initialReplace:true,seed:{query:"Alpha",nonce:1}}));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
    expect(highlights.get("smd-search")?.ranges).toHaveLength(0);
    expect(highlights.has("smd-search-current")).toBe(false);

    // Simulate virtualized block mounting into viewport and firing supermd-window-change.
    s0.setAttribute("data-windowed-mounted","true");
    s0.innerHTML='<p data-source-start="0" data-source-end="11">Alpha token</p>';
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    const firstAllHighlight=highlights.get("smd-search");
    const firstCurrentHighlight=highlights.get("smd-search-current");
    expect(firstAllHighlight?.ranges.map(x=>x.toString())).toEqual(["Alpha"]);
    expect(firstCurrentHighlight?.ranges.map(x=>x.toString())).toEqual(["Alpha"]);

    // Repeated window-change or style-height extent updates without rendered match changes reuse cached ranges and Highlight instances.
    s0.style.height="480px";
    const cachedRef=readingMatches(host,"Alpha");
    expect(readingMatches(host,"Alpha")).toBe(cachedRef);
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(highlights.get("smd-search")).toBe(firstAllHighlight);
    expect(highlights.get("smd-search-current")).toBe(firstCurrentHighlight);

    // Visibility mutation (display: none) invalidates cached matches immediately.
    s0.style.display="none";
    expect(readingMatches(host,"Alpha")).toEqual([]);

    cleanup();
    act(()=>root.unmount());
  });

  it("settles windowed Read matches across layout shifts without redundant highlight churn and cancels on manual scroll keys",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    const scrollTargets:Element[]=[];
    let scrollHeight=8000,scrollTop=0;
    Element.prototype.scrollIntoView=function(){
      scrollTargets.push(this);
      scrollTop=3200;
    };

    const host=document.createElement("div");
    host.className="android-reading";
    Object.defineProperty(host,"scrollHeight",{configurable:true,get:()=>scrollHeight});
    Object.defineProperty(host,"scrollTop",{configurable:true,get:()=>scrollTop,set:(v:number)=>{scrollTop=v;}});
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.innerHTML="<p>Needle zero</p>";
    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","false");
    s1.innerHTML='<span aria-hidden="true"></span>';
    s1.addEventListener("supermd-reveal-window",()=>{
      s1.setAttribute("data-windowed-mounted","true");
      s1.innerHTML="<p>Needle distant</p>";
    });
    const searchRootEl=document.createElement("div");
    host.append(s0,s1);
    document.body.append(searchRootEl,host);
    const cleanups=[registerWindowedText(s0,"Needle zero"),registerWindowedText(s1,"Needle distant")];

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{content:"Needle zero\n\nNeedle distant",close:()=>{}}));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
    const searchInput=searchRootEl.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(searchInput,"Needle");
    await act(async()=>{searchInput.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});

    const nextBtn=searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    await act(async()=>{nextBtn.click();});
    await act(async()=>{nextBtn.click();});
    expect(s1.getAttribute("data-windowed-mounted")).toBe("true");
    const syncedAll=highlights.get("smd-search");
    const syncedCurrent=highlights.get("smd-search-current");
    expect(syncedCurrent?.ranges[0]?.toString()).toBe("Needle");

    // Drain initial settle frames: Highlight objects are reused while rendered DOM has not mutated.
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,40));});
    expect(highlights.get("smd-search")).toBe(syncedAll);
    expect(highlights.get("smd-search-current")).toBe(syncedCurrent);

    // Delayed layout shrinkage re-scrolls active match without rebuilding unchanged highlights.
    scrollTargets.length=0;
    scrollHeight=7400;
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0].textContent).toContain("Needle distant");
    expect(highlights.get("smd-search")).toBe(syncedAll);

    // Manual scroll key outside .reading-search cancels settle immediately.
    scrollTargets.length=0;
    await act(async()=>{
      host.dispatchEvent(new KeyboardEvent("keydown",{key:"PageDown",bubbles:true}));
      scrollHeight=6900;
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollTargets).toHaveLength(0);

    cleanups.forEach(fn=>fn());
    act(()=>root.unmount());
  });

  it("maps displayed frontmatter metadata across BOM, out-of-order, quoted, folded, flow, and duplicate source spans while preserving regex replacement semantics",()=>{
    const content=[
      "\uFEFF---",
      'description: "hidden needle"',
      "tags: [needle, alpha, needle]",
      "authors:",
      "  - >",
      "    Ada",
      "    needle",
      'title: "needle \\"one\\""',
      "---",
      "Body needle.",
    ].join("\n");
    const bodyStart=content.indexOf("Body needle.");
    const host=document.createElement("div");
    host.className="android-reading";
    const props=document.createElement("header");
    props.className="document-properties";
    props.setAttribute("data-frontmatter-properties","");
    props.innerHTML=[
      '<h1 data-frontmatter-field="title">needle "one"</h1>',
      '<span data-frontmatter-field="author">Ada needle</span>',
      '<span data-frontmatter-field="secret">hidden needle</span>',
      '<span data-frontmatter-field="tag">needle</span>',
      '<span data-frontmatter-field="tag">alpha</span>',
    ].join("");
    const bodyP=document.createElement("p");
    bodyP.setAttribute("data-source-start",String(bodyStart));
    bodyP.setAttribute("data-source-end",String(content.length));
    bodyP.textContent="Body needle.";
    host.append(props,bodyP);

    const ranges=sourceMatches(content,"needle");
    // Source indices: 0=hidden description, 1=first flow tag, 2=duplicate flow tag (deduplicated in DOM), 3=folded author, 4=quoted title, 5=body.
    expect(ranges).toHaveLength(6);

    // Calling resolveSourceHighlightRange before connecting host must not poison connected calls.
    const preConnect=resolveSourceHighlightRange(host,content,ranges,4,"needle");
    document.body.append(host);
    const postConnect=resolveSourceHighlightRange(host,content,ranges,4,"needle");
    expect(preConnect?.toString()).toBe("needle");
    expect(postConnect?.startContainer.isConnected).toBe(true);

    // Rendered DOM order is title (source 4), author (source 3), tag (source 1), body (source 5); hidden secret & deduplicated tag #2 do not map.
    const domMatches=readingMatches(host,"needle");
    expect(domMatches).toHaveLength(4);
    expect(translateRenderedIndexToSource(host,content,ranges,0,"needle",false,null,domMatches)).toBe(4);
    expect(translateRenderedIndexToSource(host,content,ranges,1,"needle",false,null,domMatches)).toBe(3);
    expect(translateRenderedIndexToSource(host,content,ranges,2,"needle",false,null,domMatches)).toBe(1);
    expect(translateRenderedIndexToSource(host,content,ranges,3,"needle",false,null,domMatches)).toBe(5);
    expect(translateSourceIndexToRendered(host,content,ranges,0,"needle",false,null,domMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,2,"needle",false,null,domMatches)).toBe(-1);
    expect(translateSourceIndexToRendered(host,content,ranges,4,"needle",false,null,domMatches)).toBe(0);
    expect(translateSourceIndexToRendered(host,content,ranges,3,"needle",false,null,domMatches)).toBe(1);
    expect(translateSourceIndexToRendered(host,content,ranges,1,"needle",false,null,domMatches)).toBe(2);
    expect(translateSourceIndexToRendered(host,content,ranges,5,"needle",false,null,domMatches)).toBe(3);

    // Exact source-span single Replace targets the folded author value without touching hidden description or title.
    const replacedAuthor=replaceSourceMatches(content,"needle","spark",false,3);
    expect(replacedAuthor).toContain('description: "hidden needle"');
    expect(replacedAuthor).toContain("    Ada\n    spark");
    expect(replacedAuthor).toContain('title: "needle \\"one\\""');

    // Overridden inline style -> hidden invalidates cached DOM matches even if oldValue also contained "display: none".
    bodyP.setAttribute("style","display: none; display: block");
    expect(readingMatches(host,"needle")).toHaveLength(4);
    bodyP.setAttribute("style","display: none");
    expect(readingMatches(host,"needle")).toHaveLength(3);

    // Named capture groups replace unknown $<missing> with "" (matching String.prototype.replace), while unnamed regexes preserve literal $<missing>.
    expect(replaceSourceMatches("foo bar","(?<w>foo)","[$<w>:$<missing>]",{regexp:true})).toBe("[foo:] bar");
    expect(replaceSourceMatches("foo bar","(foo)","[$1:$<missing>]",{regexp:true})).toBe("[foo:$<missing>] bar");
  });

  it("preserves Unicode case-folding seed validation, ordered DOM range insertion, and manual host scroll cancellation across extracted modules",async()=>{
    expect(foldUnicodeForSearch("Straße İstanbul ﬁ ﬄ")).toBe("strasse i\u0307stanbul fi ffl");
    const unicodeDoc="📓 Intro — Straße and İstanbul with ﬁnale.";
    const strasseStart=unicodeDoc.indexOf("Straße");
    const istanbulStart=unicodeDoc.indexOf("İstanbul");
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",false,"Straße")).toBe(true);
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",true,"Straße")).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:istanbulStart,to:istanbulStart+8},"i\u0307stanbul",false,"İstanbul")).toBe(true);
    // Reject split UTF-16 surrogate pairs on astral code points (`📓` occupies UTF-16 indices 0..2).
    expect(isValidSeedOccurrence(unicodeDoc,{from:0,to:1},"📓",false)).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:1,to:8},"Intro",false)).toBe(false);
    // Reject stale matchText or out-of-bounds offsets.
    expect(isValidSeedOccurrence(unicodeDoc,{from:strasseStart,to:strasseStart+6},"strasse",false,"Strasse")).toBe(false);
    expect(isValidSeedOccurrence(unicodeDoc,{from:0,to:unicodeDoc.length+2},"strasse",false)).toBe(false);

    // Verify findMatchingSourceRangeIndex and insertDomRangeInOrder helper contracts.
    const sampleRanges=[{from:2,to:5},{from:10,to:14},{from:10,to:16},{from:22,to:28}];
    expect(findMatchingSourceRangeIndex(sampleRanges,{from:10,to:16})).toBe(2);
    expect(findMatchingSourceRangeIndex(sampleRanges,{from:10,to:15})).toBe(-1);

    const container=document.createElement("p");
    container.textContent="alpha Strasse Straße omega";
    const textNode=container.firstChild as Text;
    const mkRange=(s:number,e:number)=>{const r=document.createRange();r.setStart(textNode,s);r.setEnd(textNode,e);return r;};
    const rAlpha=mkRange(0,5),rStrasse=mkRange(14,20),rOmega=mkRange(21,26);
    expect(rangeStartElement(rStrasse)).toBe(container);
    const inserted=insertDomRangeInOrder([rAlpha,rOmega],rStrasse);
    expect(inserted.index).toBe(1);
    expect(inserted.ranges.map(r=>r.toString())).toEqual(["alpha","Straße","omega"]);
    expect(insertDomRangeInOrder(inserted.ranges,mkRange(14,20)).index).toBe(1);

    // Seeded offscreen Unicode-folded match keeps custom highlight across window changes and stops settling on manual host scroll (> 2px).
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    let scrollHeight=6000,scrollTop=0;
    const scrollCalls:Element[]=[];
    Element.prototype.scrollIntoView=function(){
      scrollCalls.push(this);
      scrollTop=2400;
    };

    const host=document.createElement("div");
    host.className="android-reading";
    Object.defineProperty(host,"scrollHeight",{configurable:true,get:()=>scrollHeight});
    Object.defineProperty(host,"scrollTop",{configurable:true,get:()=>scrollTop,set:(v:number)=>{scrollTop=v;}});
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","false");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end",String(unicodeDoc.length));
    s0.innerHTML='<span aria-hidden="true"></span>';
    s0.addEventListener("supermd-reveal-window",()=>{
      s0.setAttribute("data-windowed-mounted","true");
      s0.innerHTML=`<p data-source-start="0" data-source-end="${unicodeDoc.length}">${unicodeDoc}</p>`;
    });
    const searchRootEl=document.createElement("div");
    host.append(s0);
    document.body.append(searchRootEl,host);
    const cleanup=registerWindowedText(s0,unicodeDoc);

    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:unicodeDoc,
        close:()=>{},
        seed:{query:"strasse",caseSensitive:false,sourceStart:strasseStart,sourceEnd:strasseStart+6,matchText:"Straße",nonce:1},
      }));
    });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,40));});
    expect(s0.getAttribute("data-windowed-mounted")).toBe("true");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Straße");

    // Window-change preserves customCurrentRangeRef on Unicode-folded occurrence.
    await act(async()=>{
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("Straße");

    // Manual scroll delta > 2px cancels active settle passes immediately.
    scrollCalls.length=0;
    scrollTop=2450;
    await act(async()=>{
      host.dispatchEvent(new Event("scroll"));
      scrollHeight=5400;
      host.dispatchEvent(new Event("supermd-window-change"));
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    expect(scrollCalls).toHaveLength(0);

    cleanup();
    act(()=>root.unmount());
  });

  it("deduplicates inline delimiter scanning while preserving escape-only link tails, Markdown masking, and exact UTF-16 Unicode ranges",()=>{
    // Bracket labels skip single/multi-backtick code spans (exact run length), escaped brackets, and nested brackets, without pairing inner ticks of unclosed runs.
    const singleCode="[`a]b`](https://example.com)";
    expect(markdownBracketEnd(singleCode,0)).toBe(6);
    const multiCode="[``a ` ] b``](https://example.com)";
    expect(markdownBracketEnd(multiCode,0)).toBe(12);
    const mismatchedInnerTicks="[`a `` ] b`](https://example.com)";
    expect(markdownBracketEnd(mismatchedInnerTicks,0)).toBe(11);
    const unclosedMultiTicks="[``a] ` b](https://example.com)";
    expect(markdownBracketEnd(unclosedMultiTicks,0)).toBe(4);
    const escapedAndNested="[outer \\[skip\\] [inner] end](https://example.com)";
    expect(markdownBracketEnd(escapedAndNested,0)).toBe(escapedAndNested.indexOf("]("));

    // Inline (...) link tails are escape-only: backticks inside URLs do NOT open code spans, while \(, \), \\), and nested (...) balance accurately.
    const backtickUrl="[docs](https://example.com/a`b) visible `code`";
    expect(markdownLinkTailEnd(backtickUrl,6)).toBe(backtickUrl.indexOf(") visible")+1);
    const nestedParenUrl="[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) tail";
    expect(markdownLinkTailEnd(nestedParenUrl,6)).toBe(nestedParenUrl.indexOf(") tail")+1);
    const escapedParenUrl="[esc](https://example.com/foo\\)bar) tail";
    expect(markdownLinkTailEnd(escapedParenUrl,5)).toBe(escapedParenUrl.indexOf(") tail")+1);
    const escapedSlashBeforeClose="[slash](https://example.com/foo\\\\) tail";
    expect(markdownLinkTailEnd(escapedSlashBeforeClose,7)).toBe(escapedSlashBeforeClose.indexOf(") tail")+1);
    // Reference-style [label][ref] link tails still honor backtick code spans via markdownBracketEnd, while non-tails return afterBracket.
    const refTail="[label][`ref]1`] tail";
    expect(markdownLinkTailEnd(refTail,7)).toBe(refTail.indexOf(" tail"));
    expect(markdownLinkTailEnd("[literal] plain",9)).toBe(9);

    // Markdown masking + exact UTF-16 offsets across astral surrogates (`📓`), Unicode case-fold expansions (`Straße`), inline HTML, escape-only backtick URLs, inline code, and images.
    const md="📓 [See <mark>Straße</mark>](https://example.com/Straße`v1) and `[fake](https://visible.example/Straße)` after ![alt Straße](https://img.example/Straße.png).";
    const hidden=hiddenSpansInSlice(md,100);
    const isHidden=(from:number,to:number)=>hidden.some(h=>from>=h.from&&to<=h.to);
    const ranges=sourceMatches(md,"Straße",true);
    // Occurrences of "Straße" in `md`:
    // 0: visible inside <mark>Straße</mark> within link label
    // 1: hidden inside escape-only backtick URL (https://example.com/Straße`v1)
    // 2: visible inside inline code span `[fake](https://visible.example/Straße)`
    // 3: hidden inside image alt ![alt Straße]
    // 4: hidden inside image URL (https://img.example/Straße.png)
    expect(ranges).toHaveLength(5);
    expect(ranges.map(r=>md.slice(r.from,r.to))).toEqual(["Straße","Straße","Straße","Straße","Straße"]);
    expect(isHidden(ranges[0].from+100,ranges[0].to+100)).toBe(false);
    expect(isHidden(ranges[1].from+100,ranges[1].to+100)).toBe(true);
    expect(isHidden(ranges[2].from+100,ranges[2].to+100)).toBe(false);
    expect(isHidden(ranges[3].from+100,ranges[3].to+100)).toBe(true);
    expect(isHidden(ranges[4].from+100,ranges[4].to+100)).toBe(true);
    // Also verify `<mark>` and `</mark>` inside the link label are masked while `and` after the backtick URL remains unmasked.
    const openMark=md.indexOf("<mark>");
    const andWord=md.indexOf("and");
    expect(isHidden(100+openMark,100+openMark+6)).toBe(true);
    expect(isHidden(100+andWord,100+andWord+3)).toBe(false);
  });

  it("preserves distinct reveal behavior on Replace exit between Read-mode transition and manual Replace toggle",async()=>{
    const highlights=new Map<string,MockHighlight>();
    Object.defineProperty(globalThis,"CSS",{configurable:true,value:{highlights}});
    Object.defineProperty(window,"Highlight",{configurable:true,value:MockHighlight});
    Element.prototype.scrollIntoView=vi.fn();
    vi.spyOn(window,"requestAnimationFrame").mockImplementation(cb=>window.setTimeout(()=>cb(performance.now()),0));
    vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>window.clearTimeout(id));
    const flushFrames=async()=>{
      await act(async()=>{
        await new Promise(resolve=>setTimeout(resolve,15));
        await new Promise(resolve=>setTimeout(resolve,15));
      });
    };

    const p0="Alpha needle.";
    const p1="Beta needle.";
    const doc=`${p0}\n\n${p1}`;
    const p1Start=doc.indexOf(p1);
    const host=document.createElement("div");
    host.className="android-reading";
    const s0=document.createElement("section");
    s0.setAttribute("data-windowed-block","");
    s0.setAttribute("data-windowed-mounted","true");
    s0.setAttribute("data-source-start","0");
    s0.setAttribute("data-source-end",String(p0.length));
    s0.innerHTML=`<p data-source-start="0" data-source-end="${p0.length}">${p0}</p>`;

    const s1=document.createElement("section");
    s1.setAttribute("data-windowed-block","");
    s1.setAttribute("data-windowed-mounted","true");
    s1.setAttribute("data-source-start",String(p1Start));
    s1.setAttribute("data-source-end",String(doc.length));
    const mountS1=()=>{
      s1.setAttribute("data-windowed-mounted","true");
      s1.innerHTML=`<p data-source-start="${p1Start}" data-source-end="${doc.length}">${p1}</p>`;
    };
    const unmountS1=()=>{
      s1.setAttribute("data-windowed-mounted","false");
      s1.innerHTML='<span aria-hidden="true"></span>';
    };
    mountS1();
    let revealCount=0;
    s1.addEventListener("supermd-reveal-window",()=>{
      revealCount++;
      mountS1();
    });
    const searchRootEl=document.createElement("div");
    host.append(s0,s1);
    document.body.append(searchRootEl,host);
    const clean0=registerWindowedText(s0,p0);
    const clean1=registerWindowedText(s1,p1);

    const onChange=vi.fn();
    const root=createRoot(searchRootEl);
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        onChange,
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();

    // Open Replace in source and step to 2 / 2 (in s1), then simulate s1 virtualizing offscreen (`data-windowed-mounted="false"`).
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");

    unmountS1();
    revealCount=0;

    // 1. Exiting Replace via `canReplace -> false` (Live -> Read transition, `onChange` omitted) does NOT reveal/mount offscreen s1 (`exitReplacingToRendered(false)`).
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();
    expect(searchRootEl.querySelector(".search-replace")).toBeNull();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(revealCount).toBe(0);
    expect(s1.getAttribute("data-windowed-mounted")).toBe("false");

    // 2. Re-enter Live Replace at 2 / 2 with s1 unmounted, then manually toggle `Replace in source` OFF -> DOES reveal/mount s1 (`exitReplacingToRendered(true)`).
    await act(async()=>{
      root.render(createElement(ReadingSearch,{
        content:doc,
        close:()=>{},
        onChange,
        seed:{query:"needle",nonce:1},
      }));
    });
    await flushFrames();
    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(s1.getAttribute("data-windowed-mounted")).toBe("false");

    act(()=>searchRootEl.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!.click());
    await flushFrames();
    expect(searchRootEl.querySelector(".search-replace")).toBeNull();
    expect(searchRootEl.querySelector("output")?.textContent).toBe("2 / 2");
    expect(revealCount).toBe(1);
    expect(s1.getAttribute("data-windowed-mounted")).toBe("true");
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("needle");

    clean0();
    clean1();
    act(()=>root.unmount());
  });

  it("bounds hiddenSpansInSlice non-recursively across deeply nested bracket/link markup while preserving exact UTF-16 offsets and escape-only URL tails",()=>{
    // 1. 2,500-deep nested links (~95 KB, well within 200 KB block limit) with astral UTF-16 surrogates (`📓`),
    //    inner `<mark>`, HTML comment, inline code, and escape-only URL tails containing unmatched backticks and escaped `\)`.
    //    Recursive `.slice()` + `...` spread would overflow the call stack or degrade quadratically; stack traversal stays linear & merges adjacent spans.
    const depth=2500;
    const prefix="📓 Intro ";
    const core="See <!-- hidden Straße --><mark>Straße</mark> and `[keep](https://visible.example/Straße)`";
    const tailUnit="](https://example.com/Straße`v1\\)ok)";
    const deepNested=prefix+"[".repeat(depth)+core+tailUnit.repeat(depth)+" 💡 omega";
    const baseOffset=42;
    const hidden=hiddenSpansInSlice(deepNested,baseOffset);
    const isHidden=(from:number,to:number)=>hidden.some(h=>from>=h.from&&to<=h.to);

    // Adjacent `[` openings merge into 1 span, comment+`<mark>` merge into 1 span, `</mark>` stays 1 span, and all 2,500 `](...)` tails merge into 1 span = 4 disjoint sorted spans!
    expect(hidden).toHaveLength(4);
    for(let i=1;i<hidden.length;i++) expect(hidden[i-1].to).toBeLessThan(hidden[i].from);

    // Exact UTF-16 offsets: `📓` occupies 2 UTF-16 code units, so opening `[` run spans `[prefix.length, prefix.length + depth)`.
    expect(hidden[0]).toEqual({from:baseOffset+prefix.length,to:baseOffset+prefix.length+depth});
    const visibleStrasseFrom=deepNested.indexOf("<mark>Straße</mark>")+"<mark>".length;
    const codeStrasseFrom=deepNested.indexOf("visible.example/Straße")+"visible.example/".length;
    const firstTailStrasseFrom=deepNested.indexOf("https://example.com/Straße")+"https://example.com/".length;
    const lastTailStrasseFrom=deepNested.lastIndexOf("Straße");
    const omegaFrom=deepNested.lastIndexOf("omega");
    expect(deepNested.slice(visibleStrasseFrom,visibleStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(codeStrasseFrom,codeStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(firstTailStrasseFrom,firstTailStrasseFrom+6)).toBe("Straße");
    expect(deepNested.slice(lastTailStrasseFrom,lastTailStrasseFrom+6)).toBe("Straße");
    expect(isHidden(baseOffset+visibleStrasseFrom,baseOffset+visibleStrasseFrom+6)).toBe(false);
    expect(isHidden(baseOffset+codeStrasseFrom,baseOffset+codeStrasseFrom+6)).toBe(false);
    expect(isHidden(baseOffset+firstTailStrasseFrom,baseOffset+firstTailStrasseFrom+6)).toBe(true);
    expect(isHidden(baseOffset+lastTailStrasseFrom,baseOffset+lastTailStrasseFrom+6)).toBe(true);
    expect(isHidden(baseOffset+omegaFrom,baseOffset+omegaFrom+5)).toBe(false);

    // 2. Pathological 25,000 unclosed `[` brackets + badge image-in-link `[![alt](img)](dest)` + unclosed outer `[` before `![alt](img)` + >200 KB guard.
    const unclosedLead="📓 "+"[".repeat(25_000)+"[Visible Straße](https://example.com/Straße`tail) [![Badge Straße](https://img.example/Straße`1.png)](https://dest.example/Straße`2) [unclosed ![Img Straße](https://img.example/Straße`3.png)";
    const unclosedHidden=hiddenSpansInSlice(unclosedLead,10);
    const isUnclosedHidden=(from:number,to:number)=>unclosedHidden.some(h=>from>=h.from&&to<=h.to);
    const unclosedHits=sourceMatches(unclosedLead,"Straße",true);
    // 0: Visible Straße (visible)
    // 1: first link escape-only backtick URL (hidden)
    // 2: badge image alt (hidden)
    // 3: badge image URL (hidden)
    // 4: badge outer link URL (hidden)
    // 5: trailing image alt after unclosed `[` (hidden)
    // 6: trailing image URL after unclosed `[` (hidden)
    expect(unclosedHits).toHaveLength(7);
    expect(unclosedHits.map(r=>isUnclosedHidden(r.from+10,r.to+10))).toEqual([false,true,true,true,true,true,true]);
    expect(isUnclosedHidden(10+2,10+2+25_000)).toBe(false);
    expect(hiddenSpansInSlice("[x](https://example.com)".repeat(9000),0)).toEqual([]);

    // 3. End-to-end `resolveSourceHighlightRange` on a rendered block containing deeply nested links, astral UTF-16 offsets, and escape-only URL tails.
    const blockNested="📓 "+"[".repeat(400)+"Lead <mark>Straße</mark>"+"](https://example.com/Straße`x\\)y)".repeat(400)+" after";
    const host=document.createElement("div");
    host.className="markdown-body";
    host.innerHTML=`<p data-source-start="0" data-source-end="${blockNested.length}">📓 <a href="https://example.com/Straße%60x)y">Lead <mark>Straße</mark></a> after</p>`;
    document.body.append(host);
    const nestedMatches=sourceMatches(blockNested,"straße",false);
    expect(nestedMatches).toHaveLength(401);
    expect(isValidSeedOccurrence(blockNested,nestedMatches[0],"strasse",false,"Straße")).toBe(true);
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,0,"straße",false)?.toString()).toBe("Straße");
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,1,"straße",false)).toBeNull();
    expect(resolveSourceHighlightRange(host,blockNested,nestedMatches,400,"straße",false)).toBeNull();
    host.remove();
  });
});

