// @vitest-environment jsdom
import {describe,it,expect,vi} from "vitest";
import {nextSearchIndex,readingMatches,replaceSourceMatches,sourceMatches} from "./components/ReadingSearch";
import {registerWindowedText,windowedMatches} from "./windowedSearch";
describe("source search",()=>{
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
      registerWindowedText(a,"token alpha"),
      registerWindowedText(b,"token beta token"),
      registerWindowedText(c,"token gamma"),
      registerWindowedText(foreign,"token outside"),
    ];
    // Simulate editing block `a` in Live mode so its registration moves after `b` and `c`.
    cleanups.push(registerWindowedText(a,"token edited-first"));

    const compareSpy=vi.spyOn(Node.prototype,"compareDocumentPosition");
    const matches=windowedMatches(host,"token");
    expect(compareSpy).not.toHaveBeenCalled();
    expect(matches).toEqual([
      {element:a,ordinal:0},
      {element:b,ordinal:0},
      {element:b,ordinal:1},
      {element:c,ordinal:0},
    ]);

    // Verify 5,000-match cap still truncates in true DOM order even when `a` was re-registered last.
    cleanups.push(registerWindowedText(b,"hit ".repeat(3000)));
    cleanups.push(registerWindowedText(c,"hit ".repeat(3000)));
    cleanups.push(registerWindowedText(a,"hit ".repeat(10)));
    const capped=windowedMatches(host,"hit")!;
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
      '<div data-frontmatter-properties="true"><span>needle frontmatter</span></div>',
      '<p>needle visible</p>',
      '<p><span class="katex"><span class="katex-html" aria-hidden="true"><span class="mord">needle</span></span><span class="katex-mathml"><math><semantics><mrow><mi>needle</mi></mrow><annotation encoding="application/x-tex">needle</annotation></semantics></math></span></span></p>',
      '<details class="callout"><summary>Summary</summary><p>needle in closed callout</p></details>',
      '<div class="step-cards-figure is-offstage" aria-hidden="true" inert=""><p>needle offstage</p></div>',
      '<section data-windowed-block="" data-windowed-mounted="false"><span>needle unmounted</span></section>',
      '<p hidden>needle hidden-attr</p>',
      '<p inert>needle inert-attr</p>',
      '<span aria-hidden="true">needle aria-hidden</span>',
      '<span style="display: none">needle display-none</span>',
      '<span style="visibility: hidden">needle visibility-hidden</span>',
      '<svg><text>needle svg</text></svg>',
      '<button type="button">needle button</button>',
      '<script>const needle = 1;</script>',
      '<style>.needle { color: red; }</style>',
    ].join("");

    const hits=readingMatches(host,"needle");
    expect(hits.map(r=>r.toString())).toEqual(["needle","needle","needle"]);
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
});

