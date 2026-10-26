// @vitest-environment jsdom
import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import {selectedMarkdown,setSelectedMarkdownDrag} from "./copySource";
import {readingMatches} from "./components/ReadingSearch";
it('retains ordered-list start values, item overrides and partial-list selection',()=>{
  const host=document.createElement('article');host.className='markdown-body';host.innerHTML='<ol start="4"><li>Fourth</li><li value="9">Ninth</li><li>Tenth</li></ol>';document.body.append(host);
  const range=document.createRange(),selection=window.getSelection()!;range.selectNodeContents(host);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe('4. Fourth\n9. Ninth\n10. Tenth');
  const items=host.querySelectorAll('li');range.setStartBefore(items[1]);range.setEndAfter(items[2]);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe('9. Ninth\n10. Tenth');
  selection.removeAllRanges();host.remove();
});
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
it("puts the selected Markdown source on a rendered text drag without cancelling native dragging",()=>{
  const host=document.createElement("article");host.className="markdown-body";host.innerHTML='<p>Alpha <strong>bold</strong> and <a href="https://example.test">a link</a> with <span class="katex"><span class="katex-html"><span class="mord">x</span><span class="mord">2</span></span><span class="katex-mathml"><math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></span>.</p>';document.body.append(host);
  const para=host.querySelector("p")!,range=document.createRange(),selection=window.getSelection()!;
  range.selectNodeContents(para);selection.removeAllRanges();selection.addRange(range);
  const payload=new Map<string,string>([['text/html','<strong>rendered</strong>'],['text/uri-list','https://example.test']]),transfer={setData:(type:string,value:string)=>payload.set(type,value),clearData:(type:string)=>payload.delete(type)} as unknown as DataTransfer;
  const drag=new Event("dragstart",{bubbles:true,cancelable:true});Object.defineProperty(drag,"dataTransfer",{value:transfer});Object.defineProperty(drag,"target",{value:para});
  Object.defineProperty(drag,"clientX",{value:10});Object.defineProperty(drag,"clientY",{value:10});
  const text=para.firstChild!;Object.defineProperty(document,"caretPositionFromPoint",{configurable:true,value:()=>({offsetNode:text,offset:2})});
  expect(setSelectedMarkdownDrag(drag as DragEvent)).toBe(true);
  expect(payload.get("text/plain")).toBe("Alpha **bold** and [a link](https://example.test) with $x^2$.");
  expect(payload.has('text/html')).toBe(false);expect(payload.has('text/uri-list')).toBe(false);
  expect(drag.defaultPrevented).toBe(false);
  selection.removeAllRanges();Reflect.deleteProperty(document,"caretPositionFromPoint");host.remove();
});
it("leaves collapsed link drags and editable text drags alone",()=>{
  const host=document.createElement("article");host.className="markdown-body";host.innerHTML='<p><a href="https://example.test">link</a></p><textarea>source text</textarea>';document.body.append(host);
  const selection=window.getSelection()!;selection.removeAllRanges();const link=host.querySelector("a")!;
  const payload=new Map<string,string>(),transfer={setData:(type:string,value:string)=>payload.set(type,value)} as unknown as DataTransfer;
  const event=(target:Element)=>{const drag=new Event("dragstart",{bubbles:true,cancelable:true});Object.defineProperty(drag,"dataTransfer",{value:transfer});Object.defineProperty(drag,"target",{value:target});return drag as DragEvent;};
  expect(setSelectedMarkdownDrag(event(link))).toBe(false);
  const range=document.createRange();range.selectNodeContents(link);selection.addRange(range);
  expect(setSelectedMarkdownDrag(event(host.querySelector("textarea")!))).toBe(false);
  expect(payload.size).toBe(0);selection.removeAllRanges();host.remove();
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
