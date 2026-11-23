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
