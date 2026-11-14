// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));
import { prepareMarkdownExport } from "./markdownExport";
import { unified } from "unified";
import remarkParse from "remark-parse";

afterEach(() => native.mockReset());

describe("plain Markdown export assets", () => {
  it("inlines referenced SVG and preserves local raster paths and GIF bytes", async () => {
    native.mockImplementation(async (_command: string, args: any) => {
      if (args.source === "diagrams/flow.svg") return "data:image/svg+xml;base64,PHN2Zz48dGV4dD5mbG93PC90ZXh0Pjwvc3ZnPg==";
      if (args.source === "images/loop.gif") return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      throw Error("missing");
    });
    const result = await prepareMarkdownExport(
      "# Keep\n\n![Flow](diagrams/flow.svg)\n\n![Loop](images/loop.gif)\n\n```mermaid\ngraph TD; A-->B\n```\n",
      "/notes/source.smd",
    );
    expect(result.content).toContain("```svg\n<svg><text>flow</text></svg>\n```");
    expect(result.content).toContain("![Loop](images/loop.gif)");
    expect(result.content).toContain("```mermaid\ngraph TD; A-->B\n```");
    expect(result.assets["images/loop.gif"]).toMatch(/^data:image\/gif;base64,/);
    expect(result.assets["images/loop.gif"]).toBe("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    expect(Object.keys(result.assets)).toEqual(["images/loop.gif"]);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("renames generated and unnamed images deterministically and leaves remote references unfetched", async () => {
    native.mockImplementation(async (_command: string, args: any) => {
      if (args.source === "assets/import-abc123.png") return "data:image/png;base64,aGVsbG8=";
      throw Error("unexpected asset load");
    });
    const result = await prepareMarkdownExport(
      "![Generated](assets/import-abc123.png)\n\n![Paste](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n\n![Remote](https://example.test/remote.png)\n",
      "/notes/source.smd",
    );
    expect(result.content).toContain("![Generated](<image1.png>)");
    expect(result.content).toContain("![Paste](<image2.gif>)");
    expect(result.content).toContain("![Remote](https://example.test/remote.png)");
    expect(Object.keys(result.assets)).toEqual(["image1.png", "image2.gif"]);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("avoids meaningful image1 paths and reuses one generated asset for repeated reference forms", async () => {
    native.mockImplementation(async (_command: string, args: any) => {
      if (args.source === "image1.png") return "data:image/png;base64,bWVhbmluZ2Z1bA==";
      if (args.source === "assets/import-same.png") return "data:image/png;base64,Z2VuZXJhdGVk";
      throw Error(`unexpected asset ${args.source}`);
    });
    const source = "![Meaningful](image1.png)\n\n![Generated](assets/import-same.png)\n\n![Repeated][g]\n\n[g]: assets/import-same.png\n";
    const result = await prepareMarkdownExport(source, "/notes/source.md");
    expect(result.content).toContain("![Meaningful](image1.png)");
    expect(result.content.match(/<image2\.png>/g)).toHaveLength(2);
    expect(Object.keys(result.assets)).toEqual(["image1.png", "image2.png"]);
    expect(result.assets["image1.png"]).toBe("data:image/png;base64,bWVhbmluZ2Z1bA==");
    expect(result.assets["image2.png"]).toBe("data:image/png;base64,Z2VuZXJhdGVk");
    expect(source).toContain("![Generated](assets/import-same.png)");
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("does not resolve traversal paths or image-looking text inside code fences", async () => {
    native.mockResolvedValue("data:image/png;base64,aGVsbG8=");
    const source = "![Outside](../secret.png)\n\n```python\nprint(\"![Not an image](hidden.png)\")\n```\n";
    await expect(prepareMarkdownExport(source, "/notes/source.md")).rejects.toThrow("Cannot safely resolve image");
    expect(source).toBe("![Outside](../secret.png)\n\n```python\nprint(\"![Not an image](hidden.png)\")\n```\n");
    expect(native).not.toHaveBeenCalled();
  });

  it("fails visibly when an authorized local image is unavailable rather than losing it", async () => {
    native.mockRejectedValue(new Error("Choose the note folder permission"));
    await expect(prepareMarkdownExport("![Photo](images/missing.gif)", "/notes/source.smd")).rejects.toThrow("Choose the note folder permission");
  });

  it("supports reference-style raster images with the original relative name", async () => {
    native.mockResolvedValue("data:image/jpeg;base64,aGVsbG8=");
    const source = "![Cover][c]\n\n[c]: media/cover.jpeg \"Cover art\"\n";
    const result = await prepareMarkdownExport(source, "/notes/source.md");
    expect(result.content).toBe(source);
    expect(result.assets["media/cover.jpeg"]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("inlines reference-style SVG at the image use and keeps the remaining source valid", async () => {
    native.mockResolvedValue("data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+");
    const result = await prepareMarkdownExport("![Diagram][d]\n\n[d]: assets/image-a1b2c3.svg\n", "/notes/source.md");
    expect(result.content).toContain("```svg\n<svg><path/></svg>\n```");
    expect(result.content).not.toContain("image-a1b2c3");
    expect(result.assets).toEqual({});
  });

  it("wraps inline prose SVG references in actual block fences", async () => {
    native.mockResolvedValue("data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+");
    const result = await prepareMarkdownExport("Before the figure ![Diagram](diagram.svg) after the figure.\n", "/notes/source.md");
    const tree = unified().use(remarkParse).parse(result.content);
    const codes = (tree.children as any[]).filter(node => node.type === "code");
    expect(codes).toHaveLength(1);
    expect(codes[0].lang).toBe("svg");
    expect((tree.children as any[]).some(node => node.type === "paragraph" && JSON.stringify(node).includes("Before the figure"))).toBe(true);
    expect((tree.children as any[]).some(node => node.type === "paragraph" && JSON.stringify(node).includes("after the figure"))).toBe(true);
  });

  it("inlines local Mermaid source referenced by image, link, and reference syntax", async () => {
    native.mockImplementation(async (command: string, args: any) => {
      expect(command).toBe("load_text_asset");
      expect(args.source).toBe("diagrams/flow.mmd");
      return "graph TD\n  A-->B\n";
    });
    const result = await prepareMarkdownExport(
      "![Chart](diagrams/flow.mmd)\n\n[Source](diagrams/flow.mmd)\n\n![Same][flow]\n\n[flow]: diagrams/flow.mmd\n",
      "/notes/source.md",
    );
    expect(result.content.match(/```mermaid\ngraph TD\n  A--&gt;B|  A-->B\n```/g)).toHaveLength(3);
    const codeBlocks = (unified().use(remarkParse).parse(result.content).children as any[]).filter(node => node.type === "code");
    expect(codeBlocks).toHaveLength(3);
    expect(codeBlocks.every(node => node.lang === "mermaid")).toBe(true);
    expect(result.assets).toEqual({});
    expect(native).toHaveBeenCalledTimes(1);
  });
});

describe('compatible Markdown ZIP preparation',()=>{
 it('expands every step in order, keeps callouts/math and bundles SVG files',async()=>{
  native.mockImplementation(async(command:string,args:any)=>{
   expect(command).toBe('load_asset');expect(args.source).toBe('assets/first.svg');
   return 'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30"/></svg>');
  });
  const source='> [!question] Q1. Find the mean.\n> Use both values.\n\n```smd-steps\n'+JSON.stringify({title:'Mean update',steps:[{label:'Before',image:'assets/first.svg',markdown:'**Values:** 2 and 4.\n\n$$\\mu=3$$'},{label:'After',diagram:{width:120,height:100,nodes:[{id:'a',label:'3',x:60,y:50}],edges:[]},description:'The centre is 3.'}]})+'\n```\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="50">Done</text></svg>\n```';
  const result=await prepareMarkdownExport(source,'/notes/test.smd',{compatible:true});
  expect(result.content).toContain('> [!question] Q1. Find the mean.');
  expect(result.content).toContain('$$\\mu=3$$');
  expect(result.content).toContain('**Values:** 2 and 4.');
  expect(result.content.indexOf('**Before**')).toBeLessThan(result.content.indexOf('**After**'));
  expect(result.content).not.toMatch(/```(?:smd-|svg)/);
  const tree=unified().use(remarkParse).parse(result.content);
  const pictures:any[]=[];const scan=(node:any)=>{if(node.type==='image')pictures.push(node);node.children?.forEach(scan);};scan(tree);
  expect(pictures).toHaveLength(3);
  expect(Object.keys(result.assets)).toHaveLength(3);
  for(const picture of pictures)expect(result.assets[picture.url]).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(source).toContain('```smd-steps');
 });
 it('preserves supported Mermaid and never runs Python on export',async()=>{
  native.mockResolvedValue(null);
  const source='```mermaid\nflowchart LR\nA-->B\n```\n\n```python\nraise RuntimeError("must never run")\n```';
  const result=await prepareMarkdownExport(source,'/notes/test.smd',{compatible:true});
  expect(result.content).toContain('```mermaid');expect(result.content).toContain('raise RuntimeError');
  expect(native.mock.calls.every(([command])=>command!=='run_python')).toBe(true);
 });
 it('rejects malformed custom blocks instead of silently dropping frames',async()=>{
  await expect(prepareMarkdownExport('```smd-steps\n{"title":"Broken","steps":[]}\n```',null,{compatible:true})).rejects.toThrow('Invalid step sequence');
 });
});

it('exports custom trees and charts after Obsidian-style multiline display math',async()=>{
 const source='$$a=1+2\n=3.$$\n\n```smd-tree\n{"values":[8,4,12]}\n```\n\n```smd-chart\n{"title":"Line","xRange":[-2,2],"yRange":[-2,2],"series":[{"expression":"x"}]}\n```';
 const result=await prepareMarkdownExport(source,null,{compatible:true});
 expect(result.content).toContain('$$a=1+2\n=3.$$');
 expect(result.content).not.toMatch(/```smd-/);
 expect(Object.keys(result.assets)).toHaveLength(2);
 for(const uri of Object.values(result.assets))expect(atob(uri.split(',')[1])).toContain('<svg');
});
it('keeps converted SVGs inside their enclosing callout and preserves frontmatter',async()=>{
 const source='---\ntitle: Lesson\n---\n\n:::callout question Q1\nDraw the tree.\n\n```smd-tree\n{"values":[8,4,12]}\n```\n:::';
 const result=await prepareMarkdownExport(source,null,{compatible:true});
 expect(result.content).toContain('---\ntitle: Lesson\n---');
 expect(result.content).toContain('> [!QUESTION] Q1');
 expect(result.content).toMatch(/^> !\[Diagram\]/m);
 expect(result.content).not.toContain(':::');
});
