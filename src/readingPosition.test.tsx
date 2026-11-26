// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from "vitest";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import MarkdownPreview from "./components/MarkdownPreview";
import LiveEditor from "./components/LiveEditor";
import {readingCaretOffset,readingOffset,revealReadingOffset} from "./readingPosition";
import {applySharedAnchor,captureSharedAnchor,detectSplitPaneFromTarget} from "./sourceAnchor";

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
});
