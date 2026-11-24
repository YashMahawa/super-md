// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { caretRangeAtPoint } from "./caretPoint";

const originalCaretPosition = Object.getOwnPropertyDescriptor(document, "caretPositionFromPoint");
const originalCaretRange = Object.getOwnPropertyDescriptor(document, "caretRangeFromPoint");

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  if (originalCaretPosition) Object.defineProperty(document, "caretPositionFromPoint", originalCaretPosition);
  else Reflect.deleteProperty(document, "caretPositionFromPoint");
  if (originalCaretRange) Object.defineProperty(document, "caretRangeFromPoint", originalCaretRange);
  else Reflect.deleteProperty(document, "caretRangeFromPoint");
});

describe("caretRangeAtPoint", () => {
  it("builds a collapsed Range from caretPositionFromPoint text hits without calling caretRangeFromPoint", () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Alpha Bravo";
    document.body.append(paragraph);
    const text = paragraph.firstChild!;
    const positionSpy = vi.fn(() => ({ offsetNode: text, offset: 6, getClientRect: () => null }));
    const legacySpy = vi.fn();
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: positionSpy });
    Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: legacySpy });

    const range = caretRangeAtPoint(document, 24, 48);
    expect(positionSpy).toHaveBeenCalledWith(24, 48);
    expect(legacySpy).not.toHaveBeenCalled();
    expect(range).not.toBeNull();
    expect(range?.collapsed).toBe(true);
    expect(range?.startContainer).toBe(text);
    expect(range?.startOffset).toBe(6);
    expect(range?.endContainer).toBe(text);
    expect(range?.endOffset).toBe(6);
  });

  it("returns null on null or DOCUMENT_TYPE_NODE caretPositionFromPoint results without falling back", () => {
    const legacySpy = vi.fn(() => document.createRange());
    Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: legacySpy });

    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: vi.fn(() => null) });
    expect(caretRangeAtPoint(document, 10, 20)).toBeNull();

    const doctype = document.implementation.createDocumentType("html", "", "");
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: vi.fn(() => ({ offsetNode: doctype, offset: 0, getClientRect: () => null })),
    });
    expect(caretRangeAtPoint(document, 10, 20)).toBeNull();
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it("clamps CaretPosition offsets on <input>, <textarea>, and CharacterData nodes", () => {
    const input = document.createElement("input");
    input.value = "editable input value";
    const textarea = document.createElement("textarea");
    textarea.value = "multi-line textarea value";
    const text = document.createTextNode("short");
    document.body.append(input, textarea, text);

    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => ({ offsetNode: input, offset: 14, getClientRect: () => null }),
    });
    const inputRange = caretRangeAtPoint(document, 5, 5);
    expect(inputRange?.collapsed).toBe(true);
    expect(inputRange?.startContainer).toBe(input);
    expect(inputRange?.startOffset).toBe(0);

    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => ({ offsetNode: textarea, offset: 18, getClientRect: () => null }),
    });
    const textareaRange = caretRangeAtPoint(document, 8, 8);
    expect(textareaRange?.collapsed).toBe(true);
    expect(textareaRange?.startContainer).toBe(textarea);
    expect(textareaRange?.startOffset).toBe(textarea.childNodes.length);

    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 99, getClientRect: () => null }),
    });
    const clampedText = caretRangeAtPoint(document, 12, 12);
    expect(clampedText?.collapsed).toBe(true);
    expect(clampedText?.startContainer).toBe(text);
    expect(clampedText?.startOffset).toBe(5);
  });

  it("falls back to caretRangeFromPoint only when caretPositionFromPoint is absent", () => {
    Reflect.deleteProperty(document, "caretPositionFromPoint");
    Reflect.deleteProperty(document, "caretRangeFromPoint");
    expect(caretRangeAtPoint(document, 15, 30)).toBeNull();

    const paragraph = document.createElement("p");
    paragraph.textContent = "Legacy WebView";
    document.body.append(paragraph);
    const expected = document.createRange();
    expected.setStart(paragraph.firstChild!, 7);
    expected.collapse(true);
    const legacySpy = vi.fn(() => expected);
    Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: legacySpy });

    const range = caretRangeAtPoint(document, 15, 30);
    expect(legacySpy).toHaveBeenCalledWith(15, 30);
    expect(range).toBe(expected);
  });
});
