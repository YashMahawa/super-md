/** Serialize the selected rendered fragment as Markdown, not KaTeX's duplicated
 * visual glyphs. Expand selection endpoints inside math to the original formula. */
export function selectedMarkdown(selection: Selection | null): string | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range=selection.getRangeAt(0).cloneRange();
  if (!range.startContainer.parentElement?.closest(".markdown-body") || !range.endContainer.parentElement?.closest(".markdown-body")) return null;
  const mathAt=(node:Node)=>node.parentElement?.closest(".katex-display") || node.parentElement?.closest(".katex");
  const start=mathAt(range.startContainer), end=mathAt(range.endContainer);
  if(start)range.setStartBefore(start);if(end)range.setEndAfter(end);
  const serialize=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.textContent||"";
    if(!(node instanceof Element))return Array.from(node.childNodes).map(serialize).join("");
    if(node.matches("button,.image-edit-tools,.katex-mathml"))return "";
    if(node.matches(".katex-display,.katex")){const tex=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;if(tex)return node.matches(".katex-display")?`\n$$\n${tex}\n$$\n`:`$${tex}$`;}
    const content=Array.from(node.childNodes).map(serialize).join("");
    switch(node.tagName.toLowerCase()){
      case "br":return "\n";
      case "strong":case "b":return `**${content}**`;
      case "em":case "i":return `*${content}*`;
      case "a":return `[${content}](${node.getAttribute("href")||""})`;
      case "code":return node.parentElement?.tagName==="PRE"?content:`\`${content}\``;
      case "pre":return `\n\`\`\`${node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1]||""}\n${content.trimEnd()}\n\`\`\`\n`;
      case "p":case "div":case "section":return `${content}\n\n`;
      case "li":return `- ${content}\n`;
      case "h1":case "h2":case "h3":case "h4":case "h5":case "h6":return `${"#".repeat(Number(node.tagName[1]))} ${content}\n\n`;
      case "img":{const source=node.closest("[data-note-image-source]")?.getAttribute("data-note-image-source")||node.getAttribute("src")||"";return /^(data:|blob:)/.test(source)?`[${node.getAttribute("alt")||"Image"}]`:`![${node.getAttribute("alt")||""}](${source})`;}
      default:return content;
    }
  };
  return serialize(range.cloneContents()).trim();
}
