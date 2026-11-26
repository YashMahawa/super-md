// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from "vitest";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import MarkdownPreview from "./components/MarkdownPreview";
import LiveEditor from "./components/LiveEditor";
import {readingCaretOffset,readingOffset,revealReadingOffset} from "./readingPosition";
import {applyDocumentZoom} from "./documentZoom";
import {applySharedAnchor,captureSharedAnchor,detectSplitPaneFromTarget,hasExternalAnchorScroll,markProgrammaticAnchorScroll,snapshotAnchorScroll} from "./sourceAnchor";
import {Reader} from "./androidReader";

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

function buildDeepChecklistMarkdown():string {
  return [
    "# Release Readiness Checklist",
    "",
    "- [ ] 1. Platform Foundations",
    "  - [ ] 1.1 Storage & Recovery",
    "    - [x] 1.1.1 Atomic write journals",
    "      - [ ] 1.1.1.a Crash replay verification",
    "      - [ ] 1.1.1.b Unsaved draft buffer",
    "    - [ ] 1.1.2 Portable archive integrity",
    "      - [x] 1.1.2.a Asset hash validation",
    "      - [ ] 1.1.2.b Orphan cleanup guard",
    "  - [ ] 1.2 Shared Viewport Anchors",
    "    - [ ] 1.2.1 Split to Source transitions",
    "      - [ ] 1.2.1.a Deep nested checklist item target",
    "        - [ ] 1.2.1.a.i Leaf verification check",
    "      - [ ] 1.2.1.b Active draft cursor handoff",
    "- [ ] 2. Final Sign-off",
    "  - [ ] 2.1 Accessibility audit",
  ].join("\n");
}

function assignChecklistGeometry(scroller:HTMLElement,scrollTop:number):void {
  Object.defineProperty(scroller,"clientHeight",{value:320,configurable:true});
  Object.defineProperty(scroller,"scrollHeight",{value:1600,configurable:true});
  scroller.scrollTop=scrollTop;
  scroller.getBoundingClientRect=()=>({
    top:0,bottom:320,left:0,right:640,width:640,height:320,x:0,y:0,toJSON:()=>({}),
  } as DOMRect);

  const items=Array.from(scroller.querySelectorAll<HTMLElement>("li[data-source-start]"));
  const rowBounds=new Map<HTMLElement,{top:number;bottom:number}>();
  items.forEach((li,idx)=>{
    const ownTop=40+idx*48;
    rowBounds.set(li,{top:ownTop,bottom:ownTop+36});
  });

  const computeRect=(el:HTMLElement):{top:number;bottom:number}=>{
    const own=rowBounds.get(el);
    let top=own?own.top:Infinity;
    let bottom=own?own.bottom:-Infinity;
    for(const [li,box] of rowBounds){
      if(el.contains(li)){
        top=Math.min(top,box.top);
        bottom=Math.max(bottom,box.bottom);
      }
    }
    if(!Number.isFinite(top)){top=0;bottom=40;}
    return {top:top-scroller.scrollTop,bottom:bottom-scroller.scrollTop};
  };

  for(const el of scroller.querySelectorAll<HTMLElement>(".live-block,[data-source-start]")){
    el.getBoundingClientRect=()=>{
      const {top,bottom}=computeRect(el);
      return {
        top,bottom,left:24,right:600,width:576,height:Math.max(0,bottom-top),x:24,y:top,toJSON:()=>({}),
      } as DOMRect;
    };
  }
}

describe("readingPosition on deep nested checklists",()=>{
  let host:HTMLDivElement|null=null;
  let root:Root|null=null;

  afterEach(()=>{
    if(root){
      act(()=>root!.unmount());
      root=null;
    }
    host?.remove();
    host=null;
  });

  it("resolves and reveals a 5-level deep nested checklist item inside LiveEditor .live-block instead of collapsing to the outer list",()=>{
    const markdown=buildDeepChecklistMarkdown();
    const targetPhrase="- [ ] 1.2.1.a.i Leaf verification check";
    const expectedOffset=markdown.indexOf(targetPhrase);
    expect(expectedOffset).toBeGreaterThan(200);

    host=document.createElement("div");
    document.body.appendChild(host);
    root=createRoot(host);
    act(()=>{
      root!.render(<LiveEditor markdown={markdown} onChange={()=>{}} documentPath={null} python="" dark={false}/>);
    });

    const liveBlocks=host.querySelectorAll(".live-block");
    // Heading + single top-level checklist block wrapping all nested levels.
    expect(liveBlocks.length).toBe(2);
    const leafLi=Array.from(host.querySelectorAll<HTMLElement>("li[data-source-start]")).find(
      el=>Number(el.dataset.sourceStart)===expectedOffset,
    );
    expect(leafLi).toBeDefined();

    // Scroll so the 5-level deep leaf checklist item sits at the reading anchor line (y ~ 20px).
    const allItems=Array.from(host.querySelectorAll<HTMLElement>("li[data-source-start]"));
    const leafIndex=allItems.indexOf(leafLi!);
    const targetScrollTop=40+leafIndex*48-16;
    assignChecklistGeometry(host,targetScrollTop);

    expect(readingOffset(host)).toBe(expectedOffset);

    // Reset to top and reveal the deep nested checklist offset back into Live mode.
    host.scrollTop=0;
    revealReadingOffset(host,expectedOffset);
    expect(Math.abs(host.scrollTop-targetScrollTop)).toBeLessThanOrEqual(2);
    expect(readingOffset(host)).toBe(expectedOffset);
  });

  it("resolves parent vs nested checklist items accurately in MarkdownPreview (Split/Read)",()=>{
    const markdown=buildDeepChecklistMarkdown();
    const parentOffset=markdown.indexOf("- [ ] 1.2 Shared Viewport Anchors");
    const nestedOffset=markdown.indexOf("- [ ] 1.2.1.a Deep nested checklist item target");

    host=document.createElement("div");
    document.body.appendChild(host);
    root=createRoot(host);
    act(()=>{
      root!.render(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false}/>);
    });

    assignChecklistGeometry(host,0);
    revealReadingOffset(host,parentOffset);
    expect(readingOffset(host)).toBe(parentOffset);

    revealReadingOffset(host,nestedOffset);
    expect(readingOffset(host)).toBe(nestedOffset);
    expect(host.scrollTop).toBeGreaterThan(200);
  });

  it("tracks sub-block line and caret offsets inside an active Live block textarea draft",()=>{
    const lines=Array.from({length:30},(_,i)=>`${"  ".repeat(i%4)}- [ ] Draft step ${i+1}`);
    const blockText=lines.join("\n");
    const prefix="# Draft Plan\n\n";

    host=document.createElement("div");
    Object.defineProperty(host,"clientHeight",{value:300,configurable:true});
    Object.defineProperty(host,"scrollHeight",{value:1200,configurable:true});
    host.scrollTop=240;
    host.getBoundingClientRect=()=>({
      top:0,bottom:300,left:0,right:600,width:600,height:300,x:0,y:0,toJSON:()=>({}),
    } as DOMRect);

    const wrapper=document.createElement("div");
    wrapper.className="live-active-block";
    const area=document.createElement("textarea");
    area.dataset.sourceStart=String(prefix.length);
    area.value=blockText;
    area.style.paddingTop="16px";
    area.style.paddingBottom="16px";
    area.getBoundingClientRect=()=>({
      top:40-host!.scrollTop,
      bottom:40+30*28+32-host!.scrollTop,
      left:20,
      right:580,
      width:560,
      height:30*28+32,
      x:20,
      y:40-host!.scrollTop,
      toJSON:()=>({}),
    } as DOMRect);
    wrapper.appendChild(area);
    host.appendChild(wrapper);
    document.body.appendChild(host);

    const capturedOffset=readingOffset(host);
    expect(capturedOffset).toBeGreaterThan(prefix.length+100);

    const step18Offset=blockText.indexOf("- [ ] Draft step 18");
    area.focus();
    area.setSelectionRange(step18Offset,step18Offset);
    expect(readingCaretOffset(host)).toBe(prefix.length+step18Offset);

    host.scrollTop=0;
    revealReadingOffset(host,prefix.length+step18Offset);
    expect(host.scrollTop).toBeGreaterThan(350);
  });

  it("reveals enclosing windowed blocks before resolving nested checklist targets",()=>{
    host=document.createElement("div");
    const section=document.createElement("section");
    section.setAttribute("data-windowed-block","");
    section.dataset.sourceStart="50";
    section.dataset.sourceEnd="800";
    const nestedUl=document.createElement("ul");
    nestedUl.dataset.sourceStart="50";
    nestedUl.dataset.sourceEnd="800";
    const nestedLi=document.createElement("li");
    nestedLi.dataset.sourceStart="420";
    nestedLi.dataset.sourceEnd="480";
    const scrollSpy=vi.fn();
    nestedLi.scrollIntoView=scrollSpy;
    nestedUl.appendChild(nestedLi);
    section.appendChild(nestedUl);
    host.appendChild(section);
    document.body.appendChild(host);

    let revealed=false;
    section.addEventListener("supermd-reveal-window",()=>{revealed=true;});

    revealReadingOffset(host,435);
    expect(revealed).toBe(true);
    expect(scrollSpy).toHaveBeenCalledOnce();
  });

  it("selects the interacted Split pane and preserves exact or reflowed anchors across transitions",()=>{
    host=document.createElement("div");
    host.innerHTML=`
      <div class="editor-pane"><div class="cm-scroller"><div class="cm-line">source</div></div></div>
      <div class="preview-pane"><div class="reading-scroll"><p data-source-start="320" data-source-end="390">preview</p></div></div>
    `;
    document.body.appendChild(host);
    expect(detectSplitPaneFromTarget(host.querySelector(".cm-line"))).toBe("editor");
    expect(detectSplitPaneFromTarget(host.querySelector("p"))).toBe("preview");

    const readingRoot=host.querySelector<HTMLElement>(".reading-scroll")!;
    Object.defineProperty(readingRoot,"clientHeight",{value:300,configurable:true});
    Object.defineProperty(readingRoot,"scrollHeight",{value:1200,configurable:true});
    readingRoot.scrollTop=410;
    readingRoot.getBoundingClientRect=()=>({
      top:0,bottom:300,left:0,right:500,width:500,height:300,x:0,y:0,toJSON:()=>({}),
    } as DOMRect);
    const para=readingRoot.querySelector<HTMLElement>("p")!;
    para.getBoundingClientRect=()=>({
      top:20,bottom:60,left:16,right:480,width:464,height:40,x:16,y:20,toJSON:()=>({}),
    } as DOMRect);

    const anchor=captureSharedAnchor({
      id:"unsaved-draft-tab",
      mode:"split",
      zoom:100,
      readingRoot,
      preferredSplitPane:"preview",
    });
    expect(anchor.offset).toBe(320);
    expect(anchor.readingTop).toBe(410);

    // Same mode & zoom tab return keeps exact pixel scrollTop.
    readingRoot.scrollTop=0;
    applySharedAnchor({
      id:"unsaved-draft-tab",
      targetMode:"split",
      targetZoom:100,
      anchor,
      readingRoot,
      allowExactTop:true,
    });
    expect(readingRoot.scrollTop).toBe(410);
  });

  it("refreshes zoomed document-page extent and clamps negative readingTop during same-geometry anchor restore",()=>{
    host=document.createElement("div");
    host.innerHTML=`<div class="document-space"><div class="document-page"><p data-source-start="0" data-source-end="50">zoomed</p></div></div>`;
    document.body.appendChild(host);
    const space=host.querySelector<HTMLElement>(".document-space")!;
    const page=host.querySelector<HTMLElement>(".document-page")!;
    let pageHeight=400;
    Object.defineProperty(host,"clientWidth",{value:600,configurable:true});
    Object.defineProperty(host,"clientHeight",{value:400,configurable:true});
    Object.defineProperty(page,"offsetHeight",{get:()=>pageHeight,configurable:true});
    host.getBoundingClientRect=()=>({
      top:0,bottom:400,left:0,right:600,width:600,height:400,x:0,y:0,toJSON:()=>({}),
    } as DOMRect);
    page.getBoundingClientRect=()=>({
      top:0,bottom:pageHeight,left:16,right:584,width:568,height:pageHeight,x:16,y:0,toJSON:()=>({}),
    } as DOMRect);

    applyDocumentZoom(host,150,100);
    expect(space.style.height).toBe("600px");

    // Simulate document content expanding before restoring an exact zoomed scrollTop.
    pageHeight=900;
    applySharedAnchor({
      id:"zoomed-note",
      targetMode:"reader",
      targetZoom:150,
      anchor:{
        offset:0,
        mode:"reader",
        zoom:150,
        readingTop:820,
      },
      readingRoot:host,
      allowExactTop:true,
    });
    expect(space.style.height).toBe("1350px");
    expect(host.scrollTop).toBe(820);

    // Overscroll negative readingTop clamps cleanly to 0.
    applySharedAnchor({
      id:"zoomed-note",
      targetMode:"reader",
      targetZoom:150,
      anchor:{
        offset:0,
        mode:"reader",
        zoom:150,
        readingTop:-24,
      },
      readingRoot:host,
      allowExactTop:true,
    });
    expect(host.scrollTop).toBe(0);
  });

  it("detects external viewport scrolls within the programmatic window without mistaking layout adjustments or clamps",()=>{
    host=document.createElement("div");
    Object.defineProperty(host,"clientHeight",{value:820,configurable:true});
    let scrollHeight=11320;
    Object.defineProperty(host,"scrollHeight",{get:()=>scrollHeight,configurable:true});
    document.body.appendChild(host);

    markProgrammaticAnchorScroll(host);
    host.scrollTop=6928;
    const snap=snapshotAnchorScroll(host);
    expect(hasExternalAnchorScroll(snap)).toBe(false);

    // Layout-recorded scroll preservation does not count as external scroll.
    host.scrollTop=6960;
    (host as HTMLElement&{__layoutAnchorTop?:number}).__layoutAnchorTop=6960;
    expect(hasExternalAnchorScroll(snap)).toBe(false);

    // Temporary maxScrollTop clamping when layout shrinks does not count as external scroll.
    delete (host as HTMLElement&{__layoutAnchorTop?:number}).__layoutAnchorTop;
    scrollHeight=5820;
    host.scrollTop=5000;
    expect(hasExternalAnchorScroll(snap)).toBe(false);

    // Programmatic/native scrollIntoView to Appendix 20 (9913 px) is detected immediately as external scroll.
    scrollHeight=11320;
    host.scrollTop=9913;
    expect(hasExternalAnchorScroll(snap)).toBe(true);
  });

  it("stops post-transition settle timers after scrollIntoView and preserves outgoing ReadingLocation across tab switch",()=>{
    vi.useFakeTimers();
    try {
      const lecture="# Lecture 2\n\n## Bayes\n\nPosterior.\n\n## Appendix 20\n\nDerivation.\n";
      const savedPositions:Record<string,unknown>={};
      (window as unknown as {SuperMD?:unknown}).SuperMD={
        post(id:string,command:string,raw:string){
          const args=JSON.parse(raw);
          if(command==="reading_position")savedPositions[args.id]=args.location;
          window.supermdReply?.(id,command==="document_sync"?{accepted:true,revision:0}:true,null);
        },
      };
      host=document.createElement("div");
      document.body.appendChild(host);
      root=createRoot(host);
      act(()=>{root!.render(<Reader/>);});

      const baseState={
        dark:false,
        fullscreen:false,
        colors:{},
        font:"Manrope",
        size:16,
        zoom:100,
        motion:false,
        editProtocol:1,
        restorePosition:true,
      };

      // 1. Load Lecture 2 in Source mode at ## Bayes via pendingHeading, then switch to Live mode.
      act(()=>{
        window.supermdLoad?.({
          ...baseState,
          id:"tab-lecture-2",
          path:"/notes/Lecture 2.md",
          content:lecture,
          mode:"editor",
          pendingHeading:{heading:"Bayes",token:"h-1"},
        });
      });
      act(()=>{
        window.supermdLoad?.({
          ...baseState,
          id:"tab-lecture-2",
          path:"/notes/Lecture 2.md",
          content:lecture,
          mode:"live",
        });
      });

      const reading=host.querySelector<HTMLElement>(".android-reading")!;
      expect(reading).toBeTruthy();
      Object.defineProperty(reading,"clientHeight",{value:820,configurable:true});
      Object.defineProperty(reading,"scrollHeight",{value:11320,configurable:true});

      // Simulate settled #Bayes scroll (6928 px) followed by scrollIntoView to #Appendix 20 (9913 px) before 120ms timer.
      reading.scrollTop=9913;
      act(()=>{
        reading.dispatchEvent(new Event("scroll",{bubbles:true}));
        vi.advanceTimersByTime(400);
      });
      expect(reading.scrollTop).toBe(9913);

      // 2. Switch to Index.md in Live mode and verify Lecture 2's saved ReadingLocation was not overwritten with 0 or 6928.
      act(()=>{
        window.supermdLoad?.({
          ...baseState,
          id:"tab-index",
          path:"/notes/Index.md",
          content:"# Course Index\n",
          mode:"live",
        });
      });
      expect((savedPositions["tab-lecture-2"] as {top:number}).top).toBe(9913);

      // 3. Reopen Lecture 2 in Live mode and verify exact 9913 px restoration across settle timers.
      act(()=>{
        window.supermdLoad?.({
          ...baseState,
          id:"tab-lecture-2",
          path:"/notes/Lecture 2.md",
          content:lecture,
          mode:"live",
          readingLocation:savedPositions["tab-lecture-2"] as never,
        });
      });
      const reopenedReading=host.querySelector<HTMLElement>(".android-reading")!;
      Object.defineProperty(reopenedReading,"clientHeight",{value:820,configurable:true});
      Object.defineProperty(reopenedReading,"scrollHeight",{value:11320,configurable:true});
      act(()=>{vi.advanceTimersByTime(750);});
      expect(reopenedReading.scrollTop).toBe(9913);
    } finally {
      delete (window as unknown as {SuperMD?:unknown}).SuperMD;
      vi.useRealTimers();
    }
  });
});
