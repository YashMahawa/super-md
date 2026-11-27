// @vitest-environment jsdom
import {afterEach,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import {extractSelectedText,hasSelectedText,selectedMarkdown,setSelectedMarkdownDrag} from "./copySource";
import {readingMatches} from "./components/ReadingSearch";
afterEach(()=>{
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(document,"caretPositionFromPoint");
  Reflect.deleteProperty(document,"caretRangeFromPoint");
  document.body.replaceChildren();
});
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
});
it("falls back to legacy caretRangeFromPoint when caretPositionFromPoint is unavailable",()=>{
  const host=document.createElement("article");host.className="markdown-body";host.innerHTML='<p>Alpha <strong>bold</strong> and <a href="https://example.test">a link</a>.</p>';document.body.append(host);
  const para=host.querySelector("p")!,range=document.createRange(),selection=window.getSelection()!;
  range.selectNodeContents(para);selection.removeAllRanges();selection.addRange(range);
  const payload=new Map<string,string>([["text/html","<strong>rendered</strong>"]]),transfer={setData:(type:string,value:string)=>payload.set(type,value),clearData:(type:string)=>payload.delete(type)} as unknown as DataTransfer;
  const drag=new Event("dragstart",{bubbles:true,cancelable:true});Object.defineProperty(drag,"dataTransfer",{value:transfer});Object.defineProperty(drag,"target",{value:para});
  Object.defineProperty(drag,"clientX",{value:12});Object.defineProperty(drag,"clientY",{value:16});
  const pointRange=document.createRange();pointRange.setStart(para.firstChild!,3);pointRange.collapse(true);
  Reflect.deleteProperty(document,"caretPositionFromPoint");
  Object.defineProperty(document,"caretRangeFromPoint",{configurable:true,value:()=>pointRange});
  expect(setSelectedMarkdownDrag(drag as DragEvent)).toBe(true);
  expect(payload.get("text/plain")).toBe("Alpha **bold** and [a link](https://example.test).");
  expect(payload.has("text/html")).toBe(false);
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
it("serializes partial table row and multi-cell selections as pipe-delimited Markdown",()=>{
  const md="| Name | Complexity | Space |\n| --- | --- | --- |\n| Merge | $O(n \\log n)$ | $O(n)$ |\n| Heap | $O(n \\log n)$ | $O(1)$ |\n| Quick | $O(n^2)$ | $O(\\log n)$ |";
  const host=document.createElement("div");host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={md} documentPath={null} python="" dark={false}/>);document.body.append(host);
  const selection=window.getSelection()!,range=document.createRange();
  const headRow=host.querySelector("thead tr")!;
  const bodyRows=host.querySelectorAll("tbody tr");

  // Header + first body row, with browser boundary endpoint resting at start of second body row
  range.setStart(headRow,0);range.setEnd(bodyRows[1],0);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("| Name | Complexity | Space |\n| --- | --- | --- |\n| Merge | $O(n \\log n)$ | $O(n)$ |");

  // Multi-row selection within tbody
  range.setStartBefore(bodyRows[0]);range.setEndAfter(bodyRows[1]);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("| Merge | $O(n \\log n)$ | $O(n)$ |\n| --- | --- | --- |\n| Heap | $O(n \\log n)$ | $O(1)$ |");

  // Multi-cell selection within a single row, with boundary endpoint resting at start of third cell
  const cells=bodyRows[2].querySelectorAll("td");
  range.setStart(cells[0],0);range.setEnd(cells[2],0);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("| Quick | $O(n^2)$ |\n| --- | --- |");

  // Single-cell selection remains plain cell Markdown rather than a 1x1 table
  range.selectNodeContents(cells[1]);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("$O(n^2)$");
  selection.removeAllRanges();host.remove();
});
it("preserves unescaped pipes in inline math and code spans while escaping literal table cell pipes",()=>{
  const md="| Expression | Norm | Code | Notes |\n| --- | --- | --- | --- |\n| $P(A|B)$ | $|x| + |y|$ | `a \\| b` | Heads \\| tails |";
  const host=document.createElement("div");host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={md} documentPath={null} python="" dark={false}/>);document.body.append(host);
  const selection=window.getSelection()!,range=document.createRange();
  range.selectNodeContents(host.firstElementChild!);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("| Expression | Norm | Code | Notes |\n| --- | --- | --- | --- |\n| $P(A|B)$ | $|x| + |y|$ | `a | b` | Heads \\| tails |");

  const cells=host.querySelectorAll("tbody td");
  range.setStartBefore(cells[0]);range.setEndAfter(cells[3]);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("| $P(A|B)$ | $|x| + |y|$ | `a | b` | Heads \\| tails |\n| --- | --- | --- | --- |");

  // Selecting text inside the literal-pipe cell alone does not escape pipes outside table row context
  range.selectNodeContents(cells[3]);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("Heads | tails");
  selection.removeAllRanges();host.remove();
});
it("extracts source-aware text across rendered math, offscreen blocks, live textareas, inputs, and editor fallback",()=>{
  const md="Inline $\\alpha + |x|$ and display:\n\n$$\\int_0^1 x^2\\,dx$$";
  const host=document.createElement("div");host.className="live-document";
  host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={md} documentPath={null} python="" dark={false}/>);
  const area=document.createElement("textarea");area.value="Raw **live** $a|b$ block";
  const input=document.createElement("input");input.value="Search query field";
  host.append(area,input);document.body.append(host);

  const selection=window.getSelection()!,range=document.createRange();
  // Partial selection starting inside KaTeX rendered glyphs expands to clean LaTeX source matching Copy
  const katexHtml=host.querySelector(".katex .katex-html")!;
  const displayKatex=host.querySelector(".katex-display .katex-html")!;
  range.setStart(katexHtml,0);range.setEnd(displayKatex,1);selection.removeAllRanges();selection.addRange(range);
  const extractedMath=extractSelectedText({source:md});
  expect(extractedMath).toBe(selectedMarkdown(selection,md));
  expect(extractedMath).toContain("$\\alpha + |x|$ and display:");
  expect(extractedMath).toContain("$$\n\\int_0^1 x^2\\,dx\n$$");
  expect(hasSelectedText()).toBe(true);

  // Active textarea inside .live-document returns raw textarea slice instead of DOM selection
  area.focus();area.setSelectionRange(4,18);
  expect(extractSelectedText({source:md})).toBe("**live** $a|b$");
  expect(hasSelectedText()).toBe(true);
  area.setSelectionRange(2,2);

  // Active input returns raw input slice
  input.focus();input.setSelectionRange(0,12);
  expect(extractSelectedText({source:md})).toBe("Search query");
  input.setSelectionRange(0,0);input.blur();

  // Offscreen unmounted virtualized block alone uses source offsets
  selection.removeAllRanges();
  const offscreenDoc="Header\n\n$$E = mc^2$$\n\nFooter";
  const vhost=document.createElement("article");vhost.className="markdown-body";
  vhost.innerHTML='<section data-windowed-mounted="false" data-source-start="8" data-source-end="20">placeholder</section>';
  document.body.append(vhost);
  range.selectNodeContents(vhost.firstElementChild!);selection.addRange(range);
  expect(extractSelectedText({source:offscreenDoc})).toBe("$$E = mc^2$$");

  // CodeMirror fallback when DOM selection is empty and focus is inside .cm-editor
  selection.removeAllRanges();
  expect(hasSelectedText()).toBe(false);
  const cmEditor=document.createElement("div");cmEditor.className="cm-editor";cmEditor.tabIndex=-1;document.body.append(cmEditor);
  cmEditor.focus();
  expect(extractSelectedText({source:offscreenDoc,editorSelection:()=>"editor $x_1$ slice"})).toBe("editor $x_1$ slice");
  cmEditor.remove();
  window.supermdSelectedText=()=>"from global hook";
  expect(hasSelectedText()).toBe(true);
  delete window.supermdSelectedText;
  vhost.remove();host.remove();
});
it("excludes document properties header from copied Markdown while indexing only displayed title, author, and tags in reader search",()=>{
  const markdown="---\ntitle: Hidden Header Title\nauthor: Emmy Noether\ndate: 2026-03-15\ntags: [algebra, invariants]\n...\n\n# Opening Section\n\nFirst **important** sentence.";
  const host=document.createElement("div");
  host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false}/>);
  document.body.append(host);
  const article=host.querySelector(".markdown-body")!;
  const header=host.querySelector("[data-frontmatter-properties]")!;
  expect(header.textContent).toContain("Hidden Header Title");
  expect(header.textContent).toContain("Author");
  expect(header.textContent).toContain("invariants");

  const selection=window.getSelection()!;
  const fullRange=document.createRange();
  fullRange.selectNodeContents(article);
  selection.removeAllRanges();
  selection.addRange(fullRange);
  const copied=selectedMarkdown(selection,markdown);
  expect(copied).toContain("# Opening Section");
  expect(copied).toContain("First **important** sentence.");
  expect(copied).not.toContain("Hidden Header Title");
  expect(copied).not.toContain("Emmy Noether");
  expect(copied).not.toContain("Author");
  expect(copied).not.toContain("invariants");
  expect(copied?.replace(/\n{3,}/g,"\n\n")).toBe("# Opening Section\n\nFirst **important** sentence.");

  const headerOnly=document.createRange();
  headerOnly.selectNodeContents(header);
  selection.removeAllRanges();
  selection.addRange(headerOnly);
  expect(selectedMarkdown(selection,markdown)).toBe("");
  expect(extractSelectedText({source:markdown})).toBe("");
  expect(hasSelectedText()).toBe(false);

  expect(readingMatches(article,"Hidden Header Title").map(r=>r.toString())).toEqual(["Hidden Header Title"]);
  expect(readingMatches(article,"Emmy Noether").map(r=>r.toString())).toEqual(["Emmy Noether"]);
  expect(readingMatches(article,"invariants").map(r=>r.toString())).toEqual(["invariants"]);
  expect(readingMatches(article,"Author")).toEqual([]);
  expect(readingMatches(article,"2026-03-15")).toEqual([]);
  expect(readingMatches(article,"important").map(r=>r.toString())).toEqual(["important"]);
  selection.removeAllRanges();
  host.remove();
});
it("serializes highlight, subscript, superscript, kbd, underline, and strikethrough spans when copying",()=>{
  const host=document.createElement("div");
  host.innerHTML=renderToStaticMarkup(<MarkdownPreview markdown={"Study ==key idea== in H~2~O, x^2^, ~~old~~, <kbd>Ctrl</kbd>, and <u>note</u>."} documentPath={null} python="" dark={false}/>);
  document.body.append(host);
  const para=host.querySelector("p")!,range=document.createRange(),selection=window.getSelection()!;
  range.selectNodeContents(para);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("Study ==key idea== in H~2~O, x^2^, ~~old~~, <kbd>Ctrl</kbd>, and <u>note</u>.");
  const markText=host.querySelector("mark")!.firstChild!;
  range.setStart(markText,0);range.setEnd(markText,3);selection.removeAllRanges();selection.addRange(range);
  expect(selectedMarkdown(selection)).toBe("==key==");
  selection.removeAllRanges();host.remove();
});
