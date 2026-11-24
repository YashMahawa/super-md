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

it("preserves intentional escapes alongside unescaped study syntax, including single-tilde subscripts",async()=>{
  const source=[
    "\\==Literal markup==",
    "",
    "==Lead highlight== beside \\==Inline literal== and ==Closing literal\\==.",
    "",
    "Subscripts H~2~O and ~sub~ beside H\\~2\\~O and \\~literal~.",
    "",
    "Superscripts x^2^ and ^sup^ beside x\\^2\\^ and \\^literal^.",
    "",
    "Strikethrough ~~retired~~ beside \\~~kept~~, and \\%%literal comment\\%% beside %%hidden comment%%.",
    "",
    "> \\==Quoted literal== and ==Quoted highlight==",
    "",
    "- \\==List literal== and ==List highlight==",
    "",
    "Nested ==highlight with \\~literal\\~ tilde==.",
    "",
    "```text",
    "\\==Fenced literal==",
    "```",
  ].join("\n");
  const prepared=await preparePdf(source,"/notes/study.md");
  expect(prepared.content).toContain("\\==Literal markup\\=\\=");
  expect(prepared.content).not.toMatch(/(?:^|\n)==Literal markup==(?:\n|$)/);
  expect(prepared.content).toContain("==Lead highlight== beside \\=\\=Inline literal\\=\\= and \\=\\=Closing literal\\=\\=.");
  expect(prepared.content).toContain("Subscripts H~2~O and ~sub~ beside H\\~2\\~O and \\~literal\\~.");
  expect(prepared.content).toContain("Superscripts x^2^ and ^sup^ beside x\\^2\\^ and \\^literal\\^.");
  expect(prepared.content).toContain("Strikethrough ~~retired~~ beside \\~\\~kept\\~\\~, and \\%%literal comment\\%% beside .");
  expect(prepared.content).toContain("> \\==Quoted literal\\=\\= and ==Quoted highlight==");
  expect(prepared.content).toContain("* \\==List literal\\=\\= and ==List highlight==");
  expect(prepared.content).toContain("Nested ==highlight with \\~literal\\~ tilde==.");
  expect(prepared.content).toContain("\\==Fenced literal==");
  expect(prepared.content).not.toContain("hidden comment");
});
