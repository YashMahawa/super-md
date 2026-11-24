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
