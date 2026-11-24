// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));
import { prepareMarkdownExport } from "./markdownExport";
import { unified } from "unified";
import remarkParse from "remark-parse";

afterEach(() => native.mockReset());

describe("plain Markdown export assets", () => {
  it("preserves referenced SVG and local raster paths and exact bytes", async () => {
    native.mockImplementation(async (_command: string, args: any) => {
      if (args.source === "diagrams/flow.svg") return "data:image/svg+xml;base64,PHN2Zz48dGV4dD5mbG93PC90ZXh0Pjwvc3ZnPg==";
      if (args.source === "images/loop.gif") return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      throw Error("missing");
    });
    const result = await prepareMarkdownExport(
      "# Keep\n\n![Flow](diagrams/flow.svg)\n\n![Loop](images/loop.gif)\n\n```mermaid\ngraph TD; A-->B\n```\n",
      "/notes/source.smd",
    );
    expect(result.content).toContain("![Flow](diagrams/flow.svg)");
    expect(result.content).not.toContain("```svg");
    expect(result.content).toContain("![Loop](images/loop.gif)");
    expect(result.content).toContain("```mermaid\ngraph TD; A-->B\n```");
    expect(result.assets["diagrams/flow.svg"]).toBe("data:image/svg+xml;base64,PHN2Zz48dGV4dD5mbG93PC90ZXh0Pjwvc3ZnPg==");
    expect(result.assets["images/loop.gif"]).toBe("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    expect(Object.keys(result.assets)).toEqual(["diagrams/flow.svg", "images/loop.gif"]);
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

  it("rewrites reference-style generated SVG to a companion SVG asset and removes the generated definition", async () => {
    native.mockImplementation(async (_command: string, args: any) => {
      if (args.source === "image1.svg") return "data:image/svg+xml;base64,PHN2Zz48Y2lyY2xlLz48L3N2Zz4=";
      if (args.source === "assets/image-a1b2c3.svg") return "data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+";
      throw Error(`unexpected asset ${args.source}`);
    });
    const result = await prepareMarkdownExport(
      "![Existing](image1.svg)\n\n![Diagram][d]\n\n[d]: assets/image-a1b2c3.svg\n",
      "/notes/source.md",
    );
    expect(result.content).toContain("![Existing](image1.svg)");
    expect(result.content).toContain("![Diagram](<image2.svg>)");
    expect(result.content).not.toContain("image-a1b2c3");
    expect(result.content).not.toContain("```svg");
    expect(result.assets).toEqual({
      "image1.svg": "data:image/svg+xml;base64,PHN2Zz48Y2lyY2xlLz48L3N2Zz4=",
      "image2.svg": "data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+",
    });
  });

  it("keeps inline prose SVG references as linked SVG assets instead of code fences and rejects unsafe SVGs", async () => {
    native.mockResolvedValue("data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+");
    const source = "Before the figure ![Diagram](diagram.svg) after the figure.\n";
    const result = await prepareMarkdownExport(source, "/notes/source.md");
    expect(result.content).toBe(source);
    expect(result.assets).toEqual({ "diagram.svg": "data:image/svg+xml;base64,PHN2Zz48cGF0aC8+PC9zdmc+" });
    const tree = unified().use(remarkParse).parse(result.content);
    expect((tree.children as any[]).filter(node => node.type === "code")).toHaveLength(0);

    for (const unsafeSvg of [
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><path/></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><foreignObject><div>html</div></foreignObject></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://evil.example/a.png\"/></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import url('https://evil.example/a.css');</style></svg>",
    ]) {
      const encoded = `data:image/svg+xml;base64,${btoa(unsafeSvg)}`;
      native.mockResolvedValueOnce(encoded);
      await expect(prepareMarkdownExport("![Bad](diagram.svg)", "/notes/source.md")).rejects.toThrow();
      await expect(prepareMarkdownExport(`![Bad](${encoded})`, "/notes/source.md")).rejects.toThrow();
    }
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
it('converts only body callout lines while preserving wikilinks, fenced callouts, frontmatter and untouched slices',async()=>{
 native.mockResolvedValue(null);
 const frontmatter='---\ntitle: Vault Note\nlinks:\n  - "[[Concept Note]]"\n---\n\n';
 const bodyCallout=':::callout note Summary\nReview [[Concept Note]] and [[Topic#Part 1|Part 1]] before proceeding.\n:::\n\n';
 const fencedCallout='```markdown\n:::callout warning Literal Example\nKeep [[Concept Note]] and [[Topic#Part 1|Part 1]] unchanged.\n:::\n```\n\n';
 const untouchedTail='*   Untouched   spacing  with [[Concept Note]] & [[Topic#Part 1|Part 1]].\n\n~~~py\n# Unrun slice with [[Concept Note]]\nx = [1,  2,   3]\n~~~\n';
 const source=frontmatter+bodyCallout+fencedCallout+'```smd-tree\n{"values":[4,2,6]}\n```\n\n'+untouchedTail;
 const result=await prepareMarkdownExport(source,'/vault/Study.md',{compatible:true});
 expect(result.content.startsWith(frontmatter)).toBe(true);
 expect(result.content).toContain('> [!NOTE] Summary\n> Review [[Concept Note]] and [[Topic#Part 1|Part 1]] before proceeding.');
 expect(result.content).toContain(fencedCallout);
 expect(result.content.endsWith('\n\n'+untouchedTail)).toBe(true);
 expect(result.content).not.toContain('[Concept Note](Concept Note.md)');
 expect(Object.keys(result.assets)).toEqual(['image1.svg']);
});
it('joins multi-paragraph raw SVG markup with blank lines and still enforces SVG safety checks',async()=>{
 const multiParagraphSvg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">\n  <g stroke="#222">\n\n    <circle cx="20" cy="20" r="10"/>\n\n  </g>\n</svg>';
 const calloutSvg=':::callout tip Figure\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">\n\n  <rect x="2" y="2" width="16" height="16"/>\n</svg>\n:::';
 const result=await prepareMarkdownExport(`# Shapes\n\n${multiParagraphSvg}\n\n${calloutSvg}\n`,'/notes/shapes.md',{compatible:true});
 expect(Object.keys(result.assets)).toEqual(['image1.svg','image2.svg']);
 expect(atob(result.assets['image1.svg'].split(',')[1])).toContain('<circle cx="20" cy="20" r="10"');
 expect(atob(result.assets['image2.svg'].split(',')[1])).toContain('<rect x="2" y="2" width="16" height="16"');
 expect(result.content).toMatch(/^> !\[Diagram\]\(<image2\.svg>\)$/m);
 for(const unsafe of [
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle cx="5" cy="5" r="4"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>bad</div></foreignObject></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
 ]){
  await expect(prepareMarkdownExport(unsafe,'/notes/unsafe.md',{compatible:true})).rejects.toThrow();
 }
});
it('forwards custom Python interpreter and cell ordinals so duplicate cells keep distinct figures without running code',async()=>{
 const fig0='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
 const fig1='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAADklEQVR42mNk+M/AQAgAAwgB/7b5L2cAAAAASUVORK5CYII=';
 const cellSource='import matplotlib.pyplot as plt\nplt.plot([1, 2])';
 const unrunSlice='~~~python\n# Unrun third cell stays exact\nvalue = {"keep": "[[Concept Note]]"}\n~~~';
 native.mockImplementation(async(command:string,args:any)=>{
  if(command==='load_python_output'){
   expect(args.context?.document).toBe('/notes/venv-study.smd');
   expect(args.context?.interpreter).toBe('/opt/venv/bin/python');
   if(args.source===cellSource&&args.context?.cell==='0'){
    return {result:{ok:true,stdout:'first plot\n',stderr:'',images:[fig0]},provenance:{verified:true,document:'/notes/venv-study.smd',cell:'0',interpreter:'/opt/venv/bin/python'}};
   }
   if(args.source===cellSource&&args.context?.cell==='1'){
    return {result:{ok:true,stdout:'second plot\n',stderr:'',images:[fig1]},provenance:{verified:true,document:'/notes/venv-study.smd',cell:'1',interpreter:'/opt/venv/bin/python'}};
   }
   return null;
  }
  throw Error(`Unexpected command ${command}`);
 });
 const source=`# Experiment\n\n\`\`\`python\n${cellSource}\n\`\`\`\n\nBetween cells.\n\n\`\`\`python\n${cellSource}\n\`\`\`\n\n${unrunSlice}\n`;
 const snapshot=source;
 const result=await prepareMarkdownExport(source,'/notes/venv-study.smd',{compatible:true,python:'/opt/venv/bin/python'});
 expect(source).toBe(snapshot);
 expect(Object.keys(result.assets)).toEqual(['image1.png','image2.png']);
 expect(result.assets['image1.png']).toBe(fig0);
 expect(result.assets['image2.png']).toBe(fig1);
 expect(result.content.indexOf('first plot')).toBeLessThan(result.content.indexOf('second plot'));
 expect(result.content.indexOf('image1.png')).toBeLessThan(result.content.indexOf('image2.png'));
 expect(result.content).toContain(unrunSlice);
 expect(native.mock.calls.every(([command])=>command!=='run_python')).toBe(true);
});
it('preserves fenced :::callout literals, Obsidian wikilinks and C++ [[nodiscard]] when no unfenced callouts exist',async()=>{
 const source=[
  'See [[Project Notes]] and `[[Project Notes]]` plus `![[diagram.png]]`.',
  '',
  '```markdown',
  ':::callout tip "Documented syntax"',
  'Keep literal [[WikiLink]] inside fenced callout example.',
  ':::',
  '```',
  '',
  '```cpp',
  '[[nodiscard]] int compute() { return 42; }',
  '```',
 ].join('\n');
 const result=await prepareMarkdownExport(source,null,{compatible:true});
 expect(result.content).toBe(source);
 expect(result.assets).toEqual({});
});
it('converts callouts while keeping prose wikilinks, code blocks and smd-chart point arrays intact in compatible exports',async()=>{
 native.mockResolvedValue(null);
 const source=[
  ':::callout note Summary',
  'Read [[Guide|the guide]].',
  ':::',
  '',
  '````markdown',
  ':::callout warning Literal',
  ':::',
  '````',
  '',
  '```cpp',
  '[[nodiscard]] bool ok();',
  '```',
  '',
  '```bash',
  'if [[ -n "$HOME" ]]; then echo ok; fi',
  '```',
  '',
  '```smd-chart',
  '{"title":"Points","series":[{"name":"Samples","points":[[0,1],[1,2]]}]}',
  '```',
 ].join('\n');
 const result=await prepareMarkdownExport(source,null,{compatible:true});
 expect(result.content).toContain('> [!NOTE] Summary\n> Read [[Guide|the guide]].');
 expect(result.content).toContain('````markdown\n:::callout warning Literal\n:::\n````');
 expect(result.content).toContain('[[nodiscard]] bool ok();');
 expect(result.content).toContain('if [[ -n "$HOME" ]]; then echo ok; fi');
 expect(Object.keys(result.assets)).toHaveLength(1);
 expect(atob(Object.values(result.assets)[0].split(',')[1])).toContain('<svg');
});
it('preserves spaced/aliased Obsidian image embeds, URL-encoded paths and YAML frontmatter image metadata byte-for-byte',async()=>{
 const pngA='data:image/png;base64,aGVsbG8=';
 const pngB='data:image/png;base64,d29ybGQ=';
 native.mockImplementation(async(command:string,args:any)=>{
  if(command==='load_asset'&&args.source==='img.png')return pngA;
  if(command==='load_asset'&&args.source==='DM%20Images/proof-method-guide.png')return pngB;
  throw Error(`Unexpected call ${command} ${args?.source}`);
 });
 const source=[
  '---',
  'title: Discrete Math Vault',
  'banner: "![[unbundled-frontmatter-banner.png]]"',
  'related: "[[Proof Techniques]]"',
  '---',
  '',
  'Overview for [[Proof Techniques]] and [[Guide|the guide]]:',
  '',
  '![[img.png]]',
  '',
  '![[DM Images/proof-method-guide.png|Proof Method Guide]]',
  '',
  '![Encoded Guide](DM%20Images/proof-method-guide.png)',
  '',
 ].join('\n');
 const compatibleResult=await prepareMarkdownExport(source,'/vault/Discrete.md',{compatible:true});
 expect(compatibleResult.content).toBe(source);
 expect(compatibleResult.assets).toEqual({
  'img.png':pngA,
  'DM Images/proof-method-guide.png':pngB,
 });
 const plainResult=await prepareMarkdownExport(source,'/vault/Discrete.md');
 expect(plainResult.content).toBe(source);
 expect(plainResult.assets).toEqual({
  'img.png':pngA,
  'DM Images/proof-method-guide.png':pngB,
 });
});
it('extracts clean alt text when renaming app-generated Obsidian image embeds',async()=>{
 native.mockImplementation(async(command:string,args:any)=>{
  if(command==='load_asset'&&args.source==='assets/import-abc123.png')return 'data:image/png;base64,aGVsbG8=';
  if(command==='load_asset'&&args.source==='assets/image-def456.png')return 'data:image/png;base64,d29ybGQ=';
  throw Error(`Unexpected call ${command} ${args?.source}`);
 });
 const source='![[assets/import-abc123.png|Custom Diagram]]\n\n![[assets/image-def456.png]]\n';
 const result=await prepareMarkdownExport(source,'/vault/Generated.smd',{compatible:true});
 expect(result.content).toBe('![Custom Diagram](<image1.png>)\n\n![image-def456.png](<image2.png>)\n');
 expect(Object.keys(result.assets)).toEqual(['image1.png','image2.png']);
});

