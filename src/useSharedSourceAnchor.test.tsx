// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SharedSourceAnchor } from "./sourceAnchor";

const { applySharedAnchorMock, primeEditorAnchorMock } = vi.hoisted(() => ({
  applySharedAnchorMock: vi.fn(),
  primeEditorAnchorMock: vi.fn(),
}));

vi.mock("./nativeBridge", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./sourceAnchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sourceAnchor")>();
  return { ...actual, applySharedAnchor: applySharedAnchorMock, primeEditorAnchor: primeEditorAnchorMock };
});

import {
  parseImportedAnchor,
  useSharedSourceAnchor,
  useSharedSourceAnchorRefs,
  type SharedAnchorReaderState,
  type SharedSourceAnchorRefs,
} from "./useSharedSourceAnchor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let frames = new Map<number, FrameRequestCallback>();
let frameSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  applySharedAnchorMock.mockReset();
  primeEditorAnchorMock.mockReset();
  frames = new Map();
  frameSeq = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++frameSeq, cb); return frameSeq; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  host = document.createElement("div");
  host.innerHTML = '<div class="cm-scroller"></div><section class="android-reading"></section>';
  document.body.append(host);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function flushNextFrame() {
  const entries = [...frames.entries()];
  frames.clear();
  for (const [, cb] of entries) cb(16);
}

it("validates imported shared source anchors and drops invalid optional fields", () => {
  expect(parseImportedAnchor(null)).toBeUndefined();
  expect(parseImportedAnchor({ offset: -1, zoom: 100, mode: "reader" })).toBeUndefined();
  expect(parseImportedAnchor({ offset: 0, zoom: 0, mode: "reader" })).toBeUndefined();
  expect(parseImportedAnchor({ offset: 0, zoom: 100, mode: "unknown" })).toBeUndefined();
  expect(
    parseImportedAnchor({ offset: 42, caretOffset: 48, zoom: 125, mode: "split", readingTop: 180, editorTop: -5 }),
  ).toEqual({ offset: 42, caretOffset: 48, zoom: 125, mode: "split", readingTop: 180 });
});

it("unifies modeAnchor (allowExactTop: false) and resolvedAnchor (allowExactTop: true) [120, 320, 700] ms settle loops and stops on user input", () => {
  let refs!: SharedSourceAnchorRefs;
  function Harness({ state }: { state: SharedAnchorReaderState }) {
    const reference = useRef<SharedAnchorReaderState | null>(state);
    reference.current = state;
    const zoomReference = useRef(120);
    refs = useSharedSourceAnchorRefs();
    useSharedSourceAnchor({ state, reference, zoomReference, refs });
    return null;
  }

  const initial: SharedAnchorReaderState = { id: "note-1", content: "# Heading\nBody", path: null, mode: "reader" };
  act(() => root!.render(<Harness state={initial} />));
  applySharedAnchorMock.mockClear();
  primeEditorAnchorMock.mockClear();

  const modeAnchor: SharedSourceAnchor = { offset: 14, caretOffset: 18, mode: "reader", zoom: 120, readingTop: 64 };
  refs.modeAnchor.current = modeAnchor;
  act(() => root!.render(<Harness state={{ ...initial, mode: "split" }} />));

  expect(primeEditorAnchorMock).toHaveBeenCalledWith("note-1", { offset: 14, caretOffset: 18 });
  expect(applySharedAnchorMock).toHaveBeenCalledTimes(1);
  expect(applySharedAnchorMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "note-1", targetMode: "split", anchor: modeAnchor, allowExactTop: false, updateSelection: true }),
  );

  act(() => flushNextFrame());
  act(() => flushNextFrame());
  for (const stepMs of [120, 200, 380]) act(() => { vi.advanceTimersByTime(stepMs); });

  expect(applySharedAnchorMock).toHaveBeenCalledTimes(6);
  for (const call of applySharedAnchorMock.mock.calls.slice(1)) {
    expect(call[0]).toMatchObject({ allowExactTop: false, updateSelection: false });
  }

  applySharedAnchorMock.mockClear();
  const savedAnchor: SharedSourceAnchor = { offset: 30, mode: "editor", zoom: 120, editorTop: 96 };
  refs.noteViews.current.set("note-2", { anchor: savedAnchor });
  act(() => root!.render(<Harness state={{ id: "note-2", content: "# Second\nText", path: null, mode: "editor" }} />));

  expect(applySharedAnchorMock).toHaveBeenCalledTimes(1);
  expect(applySharedAnchorMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "note-2", targetMode: "editor", anchor: savedAnchor, allowExactTop: true, updateSelection: true }),
  );

  act(() => flushNextFrame());
  expect(applySharedAnchorMock).toHaveBeenCalledTimes(2);
  expect(applySharedAnchorMock).toHaveBeenLastCalledWith(expect.objectContaining({ allowExactTop: true, updateSelection: false }));

  window.dispatchEvent(new WheelEvent("wheel"));
  act(() => flushNextFrame());
  act(() => { vi.advanceTimersByTime(1000); });
  expect(applySharedAnchorMock).toHaveBeenCalledTimes(2);
});
