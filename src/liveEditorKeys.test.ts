import { describe, expect, it } from "vitest";
import { handleLiveEditorKey } from "./liveEditorKeys";

function press(
  textWithCaret: string,
  key: "Enter" | "Tab",
  options: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    protectedBlock?: boolean;
  } = {},
) {
  const first = textWithCaret.indexOf("|");
  const second = textWithCaret.indexOf("|", first + 1);
  let text: string;
  let selectionStart: number;
  let selectionEnd: number;
  if (first === -1) {
    text = textWithCaret;
    selectionStart = text.length;
    selectionEnd = text.length;
  } else if (second === -1) {
    text = textWithCaret.slice(0, first) + textWithCaret.slice(first + 1);
    selectionStart = first;
    selectionEnd = first;
  } else {
    text =
      textWithCaret.slice(0, first) +
      textWithCaret.slice(first + 1, second) +
      textWithCaret.slice(second + 1);
    selectionStart = first;
    selectionEnd = second - 1;
  }
  return handleLiveEditorKey({
    text,
    selectionStart,
    selectionEnd,
    key,
    ...options,
  });
}

function formatResult(result: ReturnType<typeof handleLiveEditorKey>): string | null {
  if (!result) return null;
  const { text, selectionStart, selectionEnd } = result;
  if (selectionStart === selectionEnd) {
    return `${text.slice(0, selectionStart)}|${text.slice(selectionStart)}`;
  }
  return `${text.slice(0, selectionStart)}|${text.slice(selectionStart, selectionEnd)}|${text.slice(selectionEnd)}`;
}

describe("handleLiveEditorKey", () => {
  describe("Enter continuation", () => {
    it("continues unordered list markers (-, *, +) and preserves nested indentation", () => {
      expect(formatResult(press("- First item|", "Enter"))).toBe("- First item\n- |");
      expect(formatResult(press("* Star item|", "Enter"))).toBe("* Star item\n* |");
      expect(formatResult(press("+ Plus item|", "Enter"))).toBe("+ Plus item\n+ |");
      expect(formatResult(press("- Parent\n  - Nested|", "Enter"))).toBe("- Parent\n  - Nested\n  - |");
    });

    it("splits list items mid-line and trims dangling spaces before the split", () => {
      expect(formatResult(press("- Split |here", "Enter"))).toBe("- Split\n- |here");
      expect(formatResult(press("- |Move down", "Enter"))).toBe("- \n- |Move down");
    });

    it("continues ordered lists (. and )) and renumbers contiguous following items", () => {
      expect(formatResult(press("1. First|", "Enter"))).toBe("1. First\n2. |");
      expect(formatResult(press("1) Paren item|", "Enter"))).toBe("1) Paren item\n2) |");
      expect(formatResult(press("1. First|\n2. Second\n3. Third", "Enter"))).toBe(
        "1. First\n2. |\n3. Second\n4. Third",
      );
      expect(formatResult(press("1. First|\n1. Lazy second", "Enter"))).toBe(
        "1. First\n2. |\n1. Lazy second",
      );
    });

    it("continues task checkboxes and unchecks newly created tasks", () => {
      expect(formatResult(press("- [ ] Todo|", "Enter"))).toBe("- [ ] Todo\n- [ ] |");
      expect(formatResult(press("- [x] Completed|", "Enter"))).toBe("- [x] Completed\n- [ ] |");
      expect(formatResult(press("- [X] Uppercase completed|", "Enter"))).toBe(
        "- [X] Uppercase completed\n- [ ] |",
      );
      expect(formatResult(press("1. [x] Ordered task|", "Enter"))).toBe("1. [x] Ordered task\n2. [ ] |");
    });

    it("continues blockquotes and callout headers without repeating callout tags", () => {
      expect(formatResult(press("> Quoted thought|", "Enter"))).toBe("> Quoted thought\n> |");
      expect(formatResult(press("> > Nested quote|", "Enter"))).toBe("> > Nested quote\n> > |");
      expect(formatResult(press("> [!answer]|", "Enter"))).toBe("> [!answer]\n> |");
      expect(formatResult(press("> [!answer]- Reveal answer|", "Enter"))).toBe(
        "> [!answer]- Reveal answer\n> |",
      );
      expect(formatResult(press("> - [x] Quoted task|", "Enter"))).toBe("> - [x] Quoted task\n> - [ ] |");
    });
  });

  describe("Enter empty-marker exit", () => {
    it("clears empty unordered, ordered, task, and quote markers instead of adding blank items", () => {
      expect(formatResult(press("- First\n- |", "Enter"))).toBe("- First\n|");
      expect(formatResult(press("  - |", "Enter"))).toBe("|");
      expect(formatResult(press("1. First\n2. |", "Enter"))).toBe("1. First\n|");
      expect(formatResult(press("1. First\n2. |\n3. Third", "Enter"))).toBe("1. First\n|\n2. Third");
      expect(formatResult(press("- [ ] |", "Enter"))).toBe("|");
      expect(formatResult(press("- [x] |", "Enter"))).toBe("|");
      expect(formatResult(press("> [!answer]\n> |", "Enter"))).toBe("> [!answer]\n|");
      expect(formatResult(press(">|", "Enter"))).toBe("|");
      expect(formatResult(press("> > |", "Enter"))).toBe("> |");
    });

    it("exits a quoted list back to the enclosing blockquote before exiting the quote", () => {
      const afterListExit = press("> - Item\n> - |", "Enter");
      expect(formatResult(afterListExit)).toBe("> - Item\n> |");
      const afterQuoteExit = handleLiveEditorKey({
        text: afterListExit!.text,
        selectionStart: afterListExit!.selectionStart,
        selectionEnd: afterListExit!.selectionEnd,
        key: "Enter",
      });
      expect(formatResult(afterQuoteExit)).toBe("> - Item\n|");
    });
  });

  describe("Tab and Shift+Tab list indentation", () => {
    it("indents and outdents unordered, task, and ordered list items while preserving caret position", () => {
      const indented = press("- First\n- Sec|ond", "Tab");
      expect(formatResult(indented)).toBe("- First\n  - Sec|ond");
      const outdented = handleLiveEditorKey({
        text: indented!.text,
        selectionStart: indented!.selectionStart,
        selectionEnd: indented!.selectionEnd,
        key: "Tab",
        shiftKey: true,
      });
      expect(formatResult(outdented)).toBe("- First\n- Sec|ond");

      const orderedIndented = press("1. First\n2. Sec|ond", "Tab");
      expect(formatResult(orderedIndented)).toBe("1. First\n   1. Sec|ond");
      const orderedOutdented = handleLiveEditorKey({
        text: orderedIndented!.text,
        selectionStart: orderedIndented!.selectionStart,
        selectionEnd: orderedIndented!.selectionEnd,
        key: "Tab",
        shiftKey: true,
      });
      expect(formatResult(orderedOutdented)).toBe("1. First\n2. Sec|ond");
    });

    it("caps nested indentation at one level deeper than the parent item and keeps root markers on Shift+Tab", () => {
      const once = press("- Parent\n- Child|", "Tab")!;
      expect(formatResult(once)).toBe("- Parent\n  - Child|");
      const capped = handleLiveEditorKey({
        text: once.text,
        selectionStart: once.selectionStart,
        selectionEnd: once.selectionEnd,
        key: "Tab",
      });
      expect(capped).toEqual({
        text: "- Parent\n  - Child",
        selectionStart: once.selectionStart,
        selectionEnd: once.selectionEnd,
      });

      const rootOutdent = press("- Root item|", "Tab", { shiftKey: true });
      expect(rootOutdent).toEqual({
        text: "- Root item",
        selectionStart: 11,
        selectionEnd: 11,
      });
    });

    it("indents and outdents multi-line selections including loose lists and quoted lists", () => {
      const multi = press("- Parent\n|- [ ] First child\n\n- [x] Second child|", "Tab")!;
      expect(formatResult(multi)).toBe("- Parent\n|  - [ ] First child\n\n  - [x] Second child|");

      const cappedMulti = handleLiveEditorKey({
        text: multi.text,
        selectionStart: multi.selectionStart,
        selectionEnd: multi.selectionEnd,
        key: "Tab",
      });
      expect(formatResult(cappedMulti)).toBe("- Parent\n|  - [ ] First child\n\n  - [x] Second child|");

      const outdentedMulti = handleLiveEditorKey({
        text: multi.text,
        selectionStart: multi.selectionStart,
        selectionEnd: multi.selectionEnd,
        key: "Tab",
        shiftKey: true,
      });
      expect(formatResult(outdentedMulti)).toBe("- Parent\n|- [ ] First child\n\n- [x] Second child|");

      expect(formatResult(press("> - Parent\n> - |Child", "Tab"))).toBe("> - Parent\n>   - |Child");
    });
  });

  describe("bypass conditions", () => {
    it("skips IME composition, protected blocks, fenced code blocks, modifiers, and non-list Tab", () => {
      expect(press("- Item|", "Enter", { isComposing: true })).toBeNull();
      expect(press("- Item|", "Tab", { isComposing: true })).toBeNull();
      expect(press("- Item|", "Enter", { protectedBlock: true })).toBeNull();
      expect(press("- Item|", "Tab", { protectedBlock: true })).toBeNull();
      expect(press("- Item|", "Enter", { shiftKey: true })).toBeNull();
      expect(press("- Item|", "Enter", { ctrlKey: true })).toBeNull();
      expect(press("|- Item", "Enter")).toBeNull();
      expect(press("---|\n", "Enter")).toBeNull();

      expect(press("Plain paragraph|", "Tab")).toBeNull();
      expect(press("# Heading|", "Tab", { shiftKey: true })).toBeNull();
      expect(press("> Quoted paragraph|", "Tab")).toBeNull();

      expect(press("```python\n- not a list|\n```", "Enter")).toBeNull();
      expect(press("> ```python\n> x = 1|\n> ```", "Enter")).toBeNull();
      expect(press("- Item\n  ```js\n  - code|\n  ```", "Tab")).toBeNull();
    });
  });
});
