declare global {
  interface Window {
    supermdSelectedText?: () => string;
  }
}

const elementAt = (node: Node | null): Element | null =>
  !node ? null : node instanceof Element ? node : node.parentElement;

/** Serialize the selected rendered fragment as Markdown, not KaTeX's duplicated
 * visual glyphs. Expand selection endpoints inside math to the original formula. */
export function selectedMarkdown(selection: Selection | null, source?:string): string | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range=selection.getRangeAt(0).cloneRange();
  const startElement=elementAt(range.startContainer), endElement=elementAt(range.endContainer);
  if (!startElement?.closest(".markdown-body,.live-document") || !endElement?.closest(".markdown-body,.live-document")) return null;
  if (startElement.closest("textarea,input,.cm-editor") || endElement.closest("textarea,input,.cm-editor")) return null;
  const atomicAt=(node:Node)=>{
    const el=elementAt(node);
    return el?.closest(".katex-display") || el?.closest(".katex") || el?.closest('[data-windowed-mounted="false"]');
  };
  const start=atomicAt(range.startContainer), end=atomicAt(range.endContainer);
  if(start)range.setStartBefore(start);if(end)range.setEndAfter(end);
  const startCell=elementAt(range.startContainer)?.closest("td,th");
  if(startCell&&startCell.childNodes.length>0&&!startCell.contains(range.endContainer)){
    const tail=document.createRange();tail.selectNodeContents(startCell);tail.setStart(range.startContainer,range.startOffset);
    if(!tail.toString()&&!tail.cloneContents().querySelector("*")){
      const row=startCell.parentElement;
      if(row?.tagName==="TR"&&startCell===row.lastElementChild&&!row.contains(range.endContainer))range.setStartAfter(row);
      else range.setStartAfter(startCell);
    }
  }
  const endCell=elementAt(range.endContainer)?.closest("td,th");
  if(endCell&&endCell.childNodes.length>0&&!endCell.contains(range.startContainer)){
    const head=document.createRange();head.selectNodeContents(endCell);head.setEnd(range.endContainer,range.endOffset);
    if(!head.toString()&&!head.cloneContents().querySelector("*")){
      const row=endCell.parentElement;
      if(row?.tagName==="TR"&&endCell===row.firstElementChild&&!row.contains(range.startContainer))range.setEndBefore(row);
      else range.setEndBefore(endCell);
    }
  }
  if(range.collapsed)return null;
  const listNumber=(item:Element):number=>{
    const list=item.parentElement!,reversed=list.hasAttribute('reversed'),step=reversed?-1:1;
    let number=Number(list.getAttribute('start')??(reversed?list.children.length:1));
    for(const sibling of Array.from(list.children)){
      if(sibling.tagName!=='LI')continue;
      if(sibling.hasAttribute('value'))number=Number(sibling.getAttribute('value'));
      if(sibling===item)return number;
      number+=step;
    }
    return number;
  };
  const serialize=(node:Node,inTableCell=false):string=>{
    if(node.nodeType===Node.TEXT_NODE){
      const text=node.textContent||"";
      return inTableCell?text.replace(/(?<!\\)\|/g,"\\|"):text;
    }
    if(!(node instanceof Element))return Array.from(node.childNodes).map(child=>serialize(child,inTableCell)).join("");
    if(source!==undefined&&node.matches('[data-windowed-mounted="false"]')) {
      const from=Number(node.getAttribute('data-source-start')),to=Number(node.getAttribute('data-source-end'));
      if(Number.isFinite(from)&&Number.isFinite(to)&&to>from)return source.slice(from,to)+'\n\n';
    }
    if(node.matches("button,.image-edit-tools,.katex-mathml"))return "";
    if(node.matches(".katex-display,.katex")){const tex=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;if(tex)return node.matches(".katex-display")?`\n$$\n${tex}\n$$\n`:`$${tex}$`;}
    if(node.tagName==="TABLE"){
      const rows=Array.from(node.querySelectorAll("tr")).filter(row=>row.closest("table")===node).map(row=>Array.from(row.children).filter(cell=>/^(TH|TD)$/.test(cell.tagName)).map(cell=>Array.from(cell.childNodes).map(child=>serialize(child,true)).join("").trim().replace(/\n+/g,"<br>"))).filter(row=>row.length>0);
      if(!rows.length)return "";
      const columns=Math.max(...rows.map(row=>row.length));
      const line=(cells:string[])=>`| ${Array.from({length:columns},(_,i)=>cells[i]||"").join(" | ")} |`;
      const body=rows.slice(1).map(line).join("\n");
      return `\n${line(rows[0])}\n${line(Array(columns).fill("---"))}${body?`\n${body}`:""}\n\n`;
    }
    if(node.tagName==="CODE"){
      const inner=Array.from(node.childNodes).map(child=>serialize(child,false)).join("");
      if(node.parentElement?.tagName==="PRE")return inner;
      const fence="`".repeat(Math.max(1,...Array.from(inner.matchAll(/`+/g),match=>match[0].length+1)));
      const pad=/^`|`$/.test(inner)?" ":"";
      return `${fence}${pad}${inner}${pad}${fence}`;
    }
    const content=Array.from(node.childNodes).map(child=>serialize(child,inTableCell)).join("");
    switch(node.tagName.toLowerCase()){
      case "br":return "\n";
      case "hr":return "\n---\n\n";
      case "blockquote":return `${content.trim().split("\n").map(line=>`> ${line}`).join("\n")}\n\n`;
      case "input":return node.getAttribute("type")==="checkbox"?`[${(node as HTMLInputElement).checked?"x":" "}] `:"";
      case "strong":case "b":return `**${content}**`;
      case "em":case "i":return `*${content}*`;
      case "a":return `[${content}](${node.getAttribute("href")||""})`;
      case "pre":return `\n\`\`\`${node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1]||""}\n${content.trimEnd()}\n\`\`\`\n`;
      case "p":case "div":case "section":return `${content}\n\n`;
      case "li":return `${node.parentElement?.tagName==='OL'?`${listNumber(node)}.`:'-'} ${content}\n`;
      case "h1":case "h2":case "h3":case "h4":case "h5":case "h6":return `${"#".repeat(Number(node.tagName[1]))} ${content}\n\n`;
      case "img":{const source=node.closest("[data-note-image-source]")?.getAttribute("data-note-image-source")||node.getAttribute("src")||"";return /^(data:|blob:)/.test(source)?`[${node.getAttribute("alt")||"Image"}]`:`![${node.getAttribute("alt")||""}](${source})`;}
      default:return content;
    }
  };
  const fragment=range.cloneContents();
  // cloneContents omits the common ancestor. Preserve ordered-list and table
  // context when copying a subset of items, rows, or cells.
  const parent=elementAt(range.commonAncestorContainer);
  if(parent?.tagName==='OL'&&Array.from(fragment.children).some(node=>node.tagName==='LI')){
    const list=parent.cloneNode(false) as Element;
    const first=Array.from(parent.children).find(node=>node.tagName==='LI'&&range.intersectsNode(node));
    if(first)list.setAttribute('start',String(listNumber(first)));
    list.append(fragment);return serialize(list).trim();
  }
  if(parent?.tagName==='TABLE'){
    const table=document.createElement('table');
    table.append(fragment);
    if(table.querySelector('tr'))return serialize(table).trim();
  }
  if(parent&&/^(THEAD|TBODY|TFOOT)$/.test(parent.tagName)){
    const rows=Array.from(fragment.children).filter(node=>node.tagName==='TR');
    const cellCount=rows.reduce((sum,row)=>sum+Array.from(row.children).filter(cell=>/^(TH|TD)$/.test(cell.tagName)).length,0);
    if(rows.length>=2||cellCount>=2){
      const table=document.createElement('table');
      table.append(fragment);return serialize(table).trim();
    }
  }
  if(parent?.tagName==='TR'){
    const cells=Array.from(fragment.children).filter(node=>/^(TH|TD)$/.test(node.tagName));
    if(cells.length>=2){
      const table=document.createElement('table'),row=document.createElement('tr');
      row.append(fragment);table.append(row);return serialize(table).trim();
    }
  }
  // cloneContents drops inline ancestors when both selection endpoints sit
  // inside the same text node. Restore their Markdown meaning for narrow
  // selections such as a few characters inside bold or linked text.
  let output:Node=fragment;
  let context=elementAt(range.commonAncestorContainer);
  while(context&&!context.matches('.markdown-body,.live-document')&&!/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/.test(context.tagName)){
    const tag=context.tagName.toLowerCase();
    if(['strong','b','em','i','a','code'].includes(tag)&&!(tag==='code'&&context.parentElement?.tagName==='PRE')){
      const wrapper=context.cloneNode(false) as Element;wrapper.append(output);output=wrapper;
    }
    context=context.parentElement;
  }
  return serialize(output).trim();
}

/** Extract the current selection as serialized Markdown/LaTeX from rendered
 * views, while preserving raw text from active inputs, Live block textareas,
 * and CodeMirror source panes. */
export function extractSelectedText(options?: { source?: string; editorSelection?: () => string | null }): string {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    try {
      const from = active.selectionStart, to = active.selectionEnd;
      if (typeof from === "number" && typeof to === "number" && to > from) {
        return active.value.slice(from, to);
      }
    } catch {
      // Non-text inputs such as checkboxes do not expose selection offsets.
    }
  }
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const inSourceEditor = Boolean(
    (range && (elementAt(range.startContainer)?.closest(".cm-editor") || elementAt(range.endContainer)?.closest(".cm-editor"))) ||
    (!range && active instanceof Element && active.closest(".cm-editor"))
  );
  if (inSourceEditor) {
    const editorText = options?.editorSelection?.();
    if (editorText) return editorText;
    return selection?.toString() || "";
  }
  const markdown = selectedMarkdown(selection, options?.source);
  if (markdown !== null) return markdown;
  return selection?.toString() || "";
}

/** True when non-whitespace text is selected in any document or editor pane. */
export function hasSelectedText(): boolean {
  if (typeof window === "undefined") return false;
  const text = typeof window.supermdSelectedText === "function" ? window.supermdSelectedText() : extractSelectedText();
  return text.trim().length > 0;
}

/** Replace the browser's rendered-text payload when a rendered Markdown
 * selection is dragged out of the document. Keep the native drag operation
 * itself intact so links, editor text, images, and internal drops retain their
 * normal behavior. */
export function setSelectedMarkdownDrag(event: Pick<DragEvent,"target"|"dataTransfer"|"defaultPrevented"|"clientX"|"clientY">, source?:string): boolean {
  if(event.defaultPrevented||!event.dataTransfer)return false;
  const target=event.target instanceof Element?event.target:null;
  if(!target)return false;
  // Do not replace native link/image drags or text drags from editable widgets.
  if(target.closest("textarea,input,.cm-editor,.image-viewer,.markdown-body img,.markdown-body svg"))return false;
  // A Live document can contain several rendered block roots. Resolve its
  // owner first so selections spanning blocks use the full document source.
  const root=target.closest(".live-document")||target.closest(".markdown-body");
  if(!root)return false;
  const selection=window.getSelection();
  if(!selection?.rangeCount||selection.isCollapsed)return false;
  // dragstart can also fire for an unselected link while an older text
  // selection remains elsewhere in the same paragraph. Resolve the pointer to
  // its caret and only replace text when dragging actually began in selection.
  const doc=target.ownerDocument as Document&{
    caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;
    caretRangeFromPoint?:(x:number,y:number)=>Range|null;
  };
  const caret=doc.caretPositionFromPoint?.(event.clientX,event.clientY);
  if(caret){
    if(!selection.getRangeAt(0).isPointInRange(caret.offsetNode,caret.offset))return false;
  }else{
    const pointRange=doc.caretRangeFromPoint?.(event.clientX,event.clientY);
    if(!pointRange||!selection.getRangeAt(0).isPointInRange(pointRange.startContainer,pointRange.startOffset))return false;
  }
  const endpointRoot=(node:Node)=>{
    const element=node instanceof Element?node:node.parentElement;
    return element?.closest(".live-document")||element?.closest(".markdown-body");
  };
  if(endpointRoot(selection.anchorNode!)!==root||endpointRoot(selection.focusNode!)!==root)return false;
  const markdown=selectedMarkdown(selection,source);
  if(markdown===null)return false;
  event.dataTransfer.setData("text/plain",markdown);
  // Rich text targets prefer the browser's HTML/URL payload over text/plain.
  // A source-text drag must match Copy, which provides Markdown plain text.
  event.dataTransfer.clearData('text/html');
  event.dataTransfer.clearData('text/uri-list');
  return true;
}
