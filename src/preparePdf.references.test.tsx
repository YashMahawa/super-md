import {afterEach,expect,it,vi} from "vitest";

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("./nativeBridge",()=>({invoke}));
import {preparePdf} from "./preparePdf";

afterEach(()=>invoke.mockReset());

it("prepares resolved reference images through the inline asset pipeline and keeps unresolved/link references",async()=>{
  const source="![A photo][hero] and [specification][docs].\n\n[hero]: assets/first.png \"Caption title\"\n[hero]: assets/second.png\n[docs]: https://example.test/spec\n![Unavailable][missing]\n";
  const original=source;
  invoke.mockResolvedValue("data:image/png;base64,AA==");
  const prepared=await preparePdf(source,"/notes/section.md");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("load_asset",{documentPath:"/notes/section.md",source:"assets/first.png"});
  expect(prepared.assets).toEqual({"asset-1.png":"AA=="});
  expect(prepared.content).toContain("![A photo](asset-1.png \"Caption title\")");
  expect(prepared.content).toContain("[specification][docs]");
  expect(prepared.content).toContain("[docs]: https://example.test/spec");
  expect(prepared.content).toContain("!\\[Unavailable]\\[missing]");
  expect(source).toBe(original);
});

it("normalizes spaced, aliased, portable, and section wikilinks in GUI PDF preparation without raw or escaped brackets",async()=>{
  const source=[
    "# Overview",
    "",
    "See [[Task Note]], [[Lecture 2#Bayes Law|Bayes]], [[study.smd]], [Deck](study.smd), and [[#Overview|Jump]].",
    "",
    "Keep `[[Task Note]]` in inline code and:",
    "",
    "```python",
    "matrix = [[1, 2], [3, 4]]",
    "```",
    "",
  ].join("\n");
  const prepared=await preparePdf(source,"/notes/index.md");
  expect(prepared.content).toContain("[Task Note](Task%20Note.md)");
  expect(prepared.content).toContain("[Bayes](Lecture%202.md#bayes-law)");
  expect(prepared.content).toContain("[study.smd](study.smd)");
  expect(prepared.content).toContain("[Deck](study.smd)");
  expect(prepared.content).toContain("[Jump](#overview)");
  expect(prepared.content).not.toContain("\\[");
  expect(prepared.content).toContain("`[[Task Note]]`");
  expect(prepared.content).toContain("matrix = [[1, 2], [3, 4]]");
});

it("preserves intentional escapes alongside unescaped study syntax, including single-tilde subscripts",async()=>{
  const source=[
    "\\==Literal markup==",
    "",
    "==Lead highlight== beside \\==Inline literal==, &#61;=Entity literal==, \\\\==After slash==, and ==Closing literal\\==.",
    "",
    "Subscripts H~2~O and ~sub~ beside H\\~2~O, H\\~2\\~O, H&#126;2~O, and \\~literal~.",
    "",
    "Superscripts x^2^ and ^sup^ beside x\\^2^, x\\^2\\^, x&#94;2^, and \\^literal^.",
    "",
    "Strikethrough ~~retired~~ beside \\~~kept~~, and \\%%literal comment\\%% beside %%hidden comment%%.",
    "",
    "\\%%single escaped comment%%",
    "",
    "> \\==Quoted literal== and ==Quoted highlight==",
    "",
    "- \\==List literal== and ==List highlight==",
    "",
    "Nested ==highlight with \\~literal\\~ tilde== and https://example.edu/~alice/notes~1.",
    "",
    "```text",
    "\\==Fenced literal==",
    "```",
  ].join("\n");
  const prepared=await preparePdf(source,"/notes/study.md");
  expect(prepared.content).toContain("\\==Literal markup\\=\\=");
  expect(prepared.content).not.toMatch(/(?:^|\n)==Literal markup==(?:\n|$)/);
  expect(prepared.content).toContain("==Lead highlight== beside \\=\\=Inline literal\\=\\=, \\=\\=Entity literal\\=\\=, \\\\==After slash==, and \\=\\=Closing literal\\=\\=.");
  expect(prepared.content).toContain("Subscripts H~2~O and ~sub~ beside H\\~2\\~O, H\\~2\\~O, H\\~2\\~O, and \\~literal\\~.");
  expect(prepared.content).toContain("Superscripts x^2^ and ^sup^ beside x\\^2\\^, x\\^2\\^, x\\^2\\^, and \\^literal\\^.");
  expect(prepared.content).toContain("Strikethrough ~~retired~~ beside \\~\\~kept\\~\\~, and \\%%literal comment\\%% beside .");
  expect(prepared.content).toContain("\\%%single escaped comment\\%%");
  expect(prepared.content).toContain("> \\==Quoted literal\\=\\= and ==Quoted highlight==");
  expect(prepared.content).toContain("* \\==List literal\\=\\= and ==List highlight==");
  expect(prepared.content).toContain("Nested ==highlight with \\~literal\\~ tilde==");
  expect(prepared.content).toContain("https://example.edu/~alice/notes~1");
  expect(prepared.content).toContain("\\==Fenced literal==");
  expect(prepared.content).not.toContain("hidden comment");
});

it("preserves repeated, forward, early, case-mismatched, multi-paragraph, and undefined footnotes for PDF numbering",async()=>{
  const source=[
    "[^early]: Early note defined before body.",
    "",
    "Lead[^second], then[^First], repeat[^SECOND], early[^early], and literal[^missing].",
    "",
    "[^first]: First definition in file, cited second.",
    "",
    "    Continuation paragraph inside first footnote.",
    "",
    "[^second]: Second definition in file, cited first.",
  ].join("\n");
  const prepared=await preparePdf(source,"/notes/footnotes.md");
  expect(prepared.content).toContain("Lead[^second], then[^First], repeat[^SECOND], early[^early], and literal\\[\\^missing].");
  expect(prepared.content).toContain("[^early]: Early note defined before body.");
  expect(prepared.content).toContain("[^first]: First definition in file, cited second.\n\n    Continuation paragraph inside first footnote.");
  expect(prepared.content).toContain("[^second]: Second definition in file, cited first.");
  expect(prepared.content).not.toContain("[^missing]:");
});
