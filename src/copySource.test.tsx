// @vitest-environment jsdom
import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import {selectedMarkdown} from "./copySource";
import {readingMatches} from "./components/ReadingSearch";
it('copying across windowed-offscreen blocks retains their complete Markdown',()=>{
  const text='Before\n\n$$x^2$$\n\nAfter',host=document.createElement('article');host.className='markdown-body';
  host.innerHTML='<p>Before</p><section data-windowed-mounted="false" data-source-start="8" data-source-end="15"></section><p>After</p>';document.body.append(host);
  const range=document.createRange();range.selectNodeContents(host);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection,text)).toBe(text);selection.removeAllRanges();host.remove();
});
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
it("preserves table structure, quotes, separators and checkboxes when copying",()=>{
  const host=document.createElement("article");host.className="markdown-body";host.innerHTML='<table><thead><tr><th>Model</th><th>Value</th></tr></thead><tbody><tr><td><strong>Coin</strong></td><td>Heads | tails</td></tr></tbody></table><blockquote><p>A quoted note</p></blockquote><hr><ul><li><input type="checkbox" checked>Complete</li></ul>';document.body.append(host);
  const range=document.createRange();range.selectNodeContents(host);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe('| Model | Value |\n| --- | --- |\n| **Coin** | Heads \\| tails |\n\n> A quoted note\n\n\n---\n\n- [x] Complete');selection.removeAllRanges();host.remove();
});
