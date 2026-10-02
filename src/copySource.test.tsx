// @vitest-environment jsdom
import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import {selectedMarkdown} from "./copySource";
import {readingMatches} from "./components/ReadingSearch";
it("copies source math exactly once alongside formatted text",()=>{
  const host=document.createElement("div");host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={'**Proof**: $\\frac{1}{2}$ equals half.'} documentPath={null} python="" dark={false}/>);document.body.append(host);
  const range=document.createRange();range.selectNodeContents(host.querySelector("p")!);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe('**Proof**: $\\frac{1}{2}$ equals half.');selection.removeAllRanges();host.remove();
});
it("finds phrases across bold spans and every occurrence in a reading document",()=>{
  const host=document.createElement("article");host.innerHTML="<p>A <strong>clear</strong> idea.</p><p>Another clear idea.</p><button>clear idea</button>";
  expect(readingMatches(host,"clear idea").map(r=>r.toString())).toEqual(["clear idea","clear idea"]);
  expect(readingMatches(host,"absent")).toEqual([]);
});
