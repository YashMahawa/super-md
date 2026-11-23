/** Serialize the selected rendered fragment as Markdown, not KaTeX's duplicated
 * visual glyphs. Expand selection endpoints inside math to the original formula. */
export function selectedMarkdown(selection: Selection | null, source?:string): string | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range=selection.getRangeAt(0).cloneRange();
  const elementAt=(node:Node)=>node instanceof Element?node:node.parentElement;
  if (!elementAt(range.startContainer)?.closest(".markdown-body,.live-document") || !elementAt(range.endContainer)?.closest(".markdown-body,.live-document")) return null;
  const mathAt=(node:Node)=>node.parentElement?.closest(".katex-display") || node.parentElement?.closest(".katex");
  const start=mathAt(range.startContainer), end=mathAt(range.endContainer);
  if(start)range.setStartBefore(start);if(end)range.setEndAfter(end);
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
  const serialize=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.textContent||"";
    if(!(node instanceof Element))return Array.from(node.childNodes).map(serialize).join("");
    if(source!==undefined&&node.matches('[data-windowed-mounted="false"]')) {
      const from=Number(node.getAttribute('data-source-start')),to=Number(node.getAttribute('data-source-end'));
      if(Number.isFinite(from)&&Number.isFinite(to)&&to>from)return source.slice(from,to)+'\n\n';
    }
    if(node.matches("button,.image-edit-tools,.katex-mathml"))return "";
    if(node.matches(".katex-display,.katex")){const tex=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;if(tex)return node.matches(".katex-display")?`\n$$\n${tex}\n$$\n`:`$${tex}$`;}
    if(node.tagName==="TABLE"){
      const rows=Array.from(node.querySelectorAll("tr")).filter(row=>row.closest("table")===node).map(row=>Array.from(row.children).filter(cell=>/^(TH|TD)$/.test(cell.tagName)).map(cell=>Array.from(cell.childNodes).map(serialize).join("").trim().replace(/\n+/g,"<br>").replace(/(?<!\\)\|/g,"\\|")));
      if(!rows.length)return "";
      const columns=Math.max(...rows.map(row=>row.length));
      const line=(cells:string[])=>`| ${Array.from({length:columns},(_,i)=>cells[i]||"").join(" | ")} |`;
      return `\n${line(rows[0])}\n${line(Array(columns).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    const content=Array.from(node.childNodes).map(serialize).join("");
    switch(node.tagName.toLowerCase()){
      case "br":return "\n";
      case "hr":return "\n---\n\n";
      case "blockquote":return `${content.trim().split("\n").map(line=>`> ${line}`).join("\n")}\n\n`;
      case "input":return node.getAttribute("type")==="checkbox"?`[${(node as HTMLInputElement).checked?"x":" "}] `:"";
      case "strong":case "b":return `**${content}**`;
      case "em":case "i":return `*${content}*`;
      case "a":return `[${content}](${node.getAttribute("href")||""})`;
      case "code":return node.parentElement?.tagName==="PRE"?content:`\`${content}\``;
      case "pre":return `\n\`\`\`${node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1]||""}\n${content.trimEnd()}\n\`\`\`\n`;
      case "p":case "div":case "section":return `${content}\n\n`;
      case "li":return `${node.parentElement?.tagName==='OL'?`${listNumber(node)}.`:'-'} ${content}\n`;
      case "h1":case "h2":case "h3":case "h4":case "h5":case "h6":return `${"#".repeat(Number(node.tagName[1]))} ${content}\n\n`;
      case "img":{const source=node.closest("[data-note-image-source]")?.getAttribute("data-note-image-source")||node.getAttribute("src")||"";return /^(data:|blob:)/.test(source)?`[${node.getAttribute("alt")||"Image"}]`:`![${node.getAttribute("alt")||""}](${source})`;}
      default:return content;
    }
  };
  const fragment=range.cloneContents();
  // cloneContents omits the common ancestor. Preserve ordered-list context
  // when copying a subset of its items rather than the complete outer list.
  const parent=elementAt(range.commonAncestorContainer);
  if(parent?.tagName==='OL'&&Array.from(fragment.children).some(node=>node.tagName==='LI')){
    const list=parent.cloneNode(false) as Element;
    const first=Array.from(parent.children).find(node=>node.tagName==='LI'&&range.intersectsNode(node));
    if(first)list.setAttribute('start',String(listNumber(first)));
    list.append(fragment);return serialize(list).trim();
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
