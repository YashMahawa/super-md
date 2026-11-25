interface LegacyCaretDocument {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Resolve a viewport coordinate to a collapsed DOM Range via standard
 * Document.caretPositionFromPoint first, falling back to legacy
 * caretRangeFromPoint only when caretPositionFromPoint is absent. */
export function caretRangeAtPoint(doc: Document, x: number, y: number): Range | null {
  if (typeof (doc as Partial<Document>).caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos || pos.offsetNode.nodeType === Node.DOCUMENT_TYPE_NODE) return null;
    const node = pos.offsetNode;
    const limit =
      (typeof CharacterData !== "undefined" && node instanceof CharacterData) ||
      node.nodeType === Node.TEXT_NODE ||
      node.nodeType === Node.CDATA_SECTION_NODE ||
      node.nodeType === Node.PROCESSING_INSTRUCTION_NODE ||
      node.nodeType === Node.COMMENT_NODE
        ? (node as CharacterData).length
        : node.childNodes.length;
    const offset = Math.max(0, Math.min(pos.offset, limit));
    const range = doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  }
  return (doc as unknown as LegacyCaretDocument).caretRangeFromPoint?.(x, y) ?? null;
}
