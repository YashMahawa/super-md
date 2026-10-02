import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("setup.complete", "true")); });
test("reading search highlights every match without switching mode and escapes cleanly",async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto("/android-reader.html");
  await page.evaluate(()=>window.supermdLoad?.({id:"search",content:"# Find notes\n\nA **probability** result.\n\n> [!QUESTION]- Hidden probability\n> Another probability result.\n\n## Last probability",path:null,mode:"reader",dark:false,fullscreen:false,colors:{},font:"sans",size:18,zoom:100}));
  await expect(page.locator("h1")).toBeVisible();
  await page.evaluate(()=>window.supermdFind?.());
  await page.getByRole("searchbox",{name:"Find in note"}).fill("probability");
  await expect(page.locator(".reading-search output")).toContainText("/ 4");
  expect(await page.evaluate(()=>CSS.highlights.get("smd-search")?.size)).toBe(4);
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await page.getByRole("button",{name:"Next",exact:true}).click();
  await expect(page.locator(".reading-search output")).toContainText("1 / 4");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  expect(await page.evaluate(()=>CSS.highlights.has("smd-search"))).toBe(false);
});
test("native document sizing stays percentage based and Live edit exits on outside click",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto("/android-reader.html");
  await page.evaluate(()=>window.supermdLoad?.({id:"width",content:"# A focused note\n\nReadable content.",path:null,mode:"live",dark:false,fullscreen:false,colors:{},font:"sans",size:18,widthPercent:80,lineHeight:1.8,zoom:100}));
  const text=page.locator(".markdown-body").first();
  await expect(text).toHaveCSS("line-height","32.4px");
  const ratio=()=>text.evaluate(node=>node.getBoundingClientRect().width/node.closest(".android-reading")!.getBoundingClientRect().width);
  expect(await ratio()).toBeCloseTo(.8,1);
  await page.setViewportSize({width:1000,height:700});expect(await ratio()).toBeCloseTo(.8,1);
  await page.getByRole("heading").click();await expect(page.locator("textarea")).toHaveCount(0);
  await page.getByRole("heading").dblclick();await expect(page.getByLabel("Edit Markdown block")).toBeVisible();
  await page.locator(".android-reading").click({position:{x:5,y:500}});await expect(page.getByLabel("Edit Markdown block")).toHaveCount(0);
});
test("repair dialog uses bounded checkboxes and image zoom is focal with its own Material slider",async({page})=>{
  const image="data:image/svg+xml;base64,"+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="teal"/></svg>').toString("base64");
  await page.exposeFunction("imageBridge",(id:string,command:string)=>void page.evaluate(({id,result})=>window.supermdReply?.(id,result,null),{id,result:command==="load_asset"?image:true}));
  await page.addInitScript(()=>{window.SuperMD={post:(id,command)=>(window as any).imageBridge(id,command)};});
  await page.goto("/android-reader.html");
  await page.evaluate(()=>window.supermdLoad?.({id:"repair-image",content:String.raw`# Repair\n\n\(x^2\)\n\n![Proof](assets/proof.svg)`.replaceAll("\\n","\n"),path:"repair-image",mode:"reader",dark:false,fullscreen:true,colors:{},font:"sans",size:18,zoom:100}));
  await expect(page.locator(".markdown-body img")).toBeVisible();
  await page.evaluate(()=>window.supermdRepairMath?.());
  const panel=page.getByRole("dialog",{name:"Review LaTeX repairs"});await expect(panel).toBeVisible();
  const box=await panel.getByRole("checkbox").first().boundingBox();expect(box!.width).toBeLessThanOrEqual(24);expect(box!.height).toBeLessThanOrEqual(24);
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(740);
  await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
  await page.locator(".markdown-body img").click();
  const viewer=page.getByRole("dialog",{name:"Image viewer"});await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("slider",{name:"Image zoom"})).toBeVisible();
  const img=viewer.locator("img"),before=(await img.boundingBox())!,focus={x:before.x+before.width*.3,y:before.y+before.height*.35};
  await page.mouse.move(focus.x,focus.y);await page.mouse.wheel(0,-200);
  await expect(viewer.locator("output")).not.toHaveText("100%");
  const after=(await img.boundingBox())!;
  expect(after.x+after.width*.3).toBeCloseTo(focus.x,0);expect(after.y+after.height*.35).toBeCloseTo(focus.y,0);
  await page.keyboard.press("Escape");await expect(viewer).toHaveCount(0);
});
test("moving a Source tab preserves its undo history and caret in another document window", async ({ page, context }) => {
  let transfer: any;
  await page.exposeFunction("captureMove", (_id:string, command:string, raw:string) => { if (command === "document_flushed") transfer = JSON.parse(raw); });
  await page.addInitScript(() => { window.SuperMD = {post: (id, command, raw) => (window as any).captureMove(id, command, raw)}; });
  await page.goto("/android-reader.html");
  const note = {id:"moving",content:"# Draft\n\n",path:null,mode:"editor" as const,dark:false,fullscreen:false,colors:{},font:"sans",size:17,zoom:100};
  await page.evaluate(note => window.supermdLoad?.(note), note);
  const source = page.locator(".cm-content"); await expect(source).toBeVisible();
  await source.click(); await page.keyboard.press("Control+End");
  await page.keyboard.type("preserve this edit");
  await page.evaluate(() => window.supermdFlush?.({action:"detach_tab",target:"moving",token:"transfer"}));
  await expect.poll(() => transfer?.viewState?.editor).toBeTruthy();
  const destination = await context.newPage();
  await destination.addInitScript(() => { window.SuperMD = {post: () => {}}; });
  await destination.goto("/android-reader.html");
  await destination.evaluate(note => window.supermdLoad?.(note), {...note,content:transfer.content,viewState:transfer.viewState});
  await expect(destination.locator(".cm-content")).toContainText("preserve this edit");
  await expect(destination.getByLabel("Source editor status")).toContainText("Ln 3, Col 19");
  await destination.locator(".cm-content").click(); await destination.keyboard.press("Control+z");
  await expect(destination.locator(".cm-content")).not.toContainText("preserve this edit");
  await destination.close();
});
test("desktop reading and Source scroll indicators hide without collapsing their gutter", async ({ page }) => {
  await page.addInitScript(() => { window.SuperMD = { post: () => {} }; });
  await page.goto("/android-reader.html");
  await page.evaluate(async () => {
    document.documentElement.dataset.host = "qt";
    // @ts-expect-error Vite serves this test-only source import directly.
    const { installScrollIndicators } = await import("/src/scrollIndicators.ts");
    installScrollIndicators();
  });
  const content = Array.from({length: 100}, (_, i) => `## Section ${i}\n\nSome readable text.`).join("\n\n");
  await page.evaluate(content => window.supermdLoad?.({id:"scroll",content,path:null,mode:"reader",dark:false,fullscreen:false,colors:{},font:"sans",size:17,zoom:100}), content);
  const reader = page.locator(".android-reading");
  await expect(reader).toBeVisible();
  await page.evaluate(content => window.supermdLoad?.({id:"scroll",content,path:null,mode:"reader",dark:false,fullscreen:false,colors:{},font:"serif",size:24,zoom:140}), content);
  await expect.poll(() => reader.evaluate(node => node.scrollTop)).toBe(0);
  await expect.poll(() => page.locator("h2").first().evaluate(node => node.getBoundingClientRect().top - node.closest(".android-reading")!.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  const width = await reader.evaluate(node => node.clientWidth);
  await reader.evaluate(node => { node.scrollTop = 300; });
  await expect(reader).toHaveClass(/scroll-indicator-active/);
  await expect(reader).not.toHaveClass(/scroll-indicator-active/, {timeout: 2000});
  expect(await reader.evaluate(node => node.clientWidth)).toBe(width);
  const rect = (await reader.boundingBox())!;
  await page.mouse.move(rect.x + rect.width - 20, rect.y + 100);
  await expect(reader).toHaveClass(/scroll-indicator-hover/);
  await page.mouse.move(rect.x + 100, rect.y + 100);
  await expect(reader).not.toHaveClass(/scroll-indicator-hover/);
  await page.evaluate(content => window.supermdLoad?.({id:"scroll",content,path:null,mode:"editor",dark:false,fullscreen:false,colors:{},font:"sans",size:17,zoom:100}), content);
  const source = page.locator(".cm-scroller");
  await expect(source).toBeVisible();
  await source.evaluate(node => { node.scrollTop = 300; });
  await expect(source).toHaveClass(/scroll-indicator-active/);
  await expect(source).not.toHaveClass(/scroll-indicator-active/, {timeout:2000});
});
test("tabs, undo, sidebar and layout survive view changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await expect(page.getByRole("tab", { name: "Welcome.smd" })).toBeVisible();
  const height = await page.locator(".workspace").evaluate((node) => node.getBoundingClientRect().height); expect(height).toBeGreaterThan(600);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("button", { name: "editor view", exact: true }).click();
  await page.locator(".cm-content").click(); await page.keyboard.type("recoverable work");
  await page.getByRole("tab", { name: "Welcome.smd" }).click(); await page.getByRole("tab", { name: "Untitled.smd" }).click();
  await expect(page.locator(".cm-content")).toContainText("recoverable work");
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+z");
  await expect(page.locator(".cm-content")).not.toContainText("recoverable work");
  await page.keyboard.type("keep this draft");
  await page.getByRole("button", { name: "Close Untitled.smd", exact: true }).click(); await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("keep this draft");
  await page.reload(); await expect(page.locator(".cm-content")).toContainText("keep this draft");
  await page.getByRole("button", { name: "Toggle folder sidebar" }).click(); await expect(page.getByRole("complementary", { name: "Folder explorer" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop-workspace.png") });
});

test("Android shares math, callouts, graphs and portable PDF preparation", async ({ page }) => {
  const requests: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    requests.push({ command, args: JSON.parse(raw) });
    const result = command === "run_python" ? { ok: true, stdout: "local-python-ok", stderr: "", images: ["data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><path d="M0 40L100 10" stroke="blue"/></svg>').toString("base64")] } : true;
    void page.evaluate(({ id, result }) => window.supermdReply?.(id, result, null), { id, result });
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto("/android-reader.html");
  const chart = JSON.stringify({ x: { min: -3, max: 3 }, series: [{ expression: "a * sin(x)" }], sliders: [{ name: "a", min: 0, max: 3, value: 1 }] });
  await page.evaluate((content) => window.supermdLoad?.({ id: "note", content, path: null, mode: "reader", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), `> [!TIP] Learn\n> Work through the equation.\n\n$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$\n\n\`\`\`smd-chart\n${chart}\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  Read --> Understand\n\`\`\`\n\n\`\`\`python\nprint('local-python-ok')\n\`\`\``);
  await expect(page.locator(".callout-tip")).toBeVisible(); await expect(page.locator(".katex-error")).toHaveCount(0); await expect(page.locator(".katex")).toHaveCount(1);
  // Python source has no highlight.js wrapper; it must remain legible against
  // the fixed dark code surface even when the document uses a light theme.
  if (!await page.locator(".python-cell details").evaluate(node => (node as HTMLDetailsElement).open)) await page.locator(".python-cell summary").click();
  await expect(page.locator(".python-cell pre code")).toBeVisible();
  await expect(page.locator(".python-cell pre code")).toHaveCSS("color", "rgb(238, 237, 244)");
  await expect(page.locator(".python-cell .hljs-string")).toContainText("local-python-ok");
  await expect(page.locator(".mermaid svg")).toBeVisible(); await page.locator(".chart-controls input[type=range]").fill("1.98");
  await page.getByRole("button", { name: "Run" }).click(); await expect(page.locator(".cell-output")).toContainText("local-python-ok");
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  expect(requests.find((item) => item.command === "export_failed")).toBeUndefined();
  await expect.poll(() => requests.some((item) => item.command === "export_pdf_native")).toBeTruthy();
  const prepared = requests.find((item) => item.command === "export_pdf_native")!.args;
  expect(Object.keys(prepared.assets)).toHaveLength(3); expect(prepared.content).not.toContain("```mermaid"); expect(prepared.options.pageNumbers).toBe(false);
  expect(prepared.content).toContain("print('local-python-ok')"); expect(prepared.content).toContain("local-python-ok");
  const input = test.info().outputPath("prepared.md"); await mkdir(dirname(input), { recursive: true }); await writeFile(input, prepared.content);
  expect(prepared.content).toMatch(/^> \[!TIP\] Learn\n> Work through the equation\.\n\n/);
  expect(prepared.content).toContain("\n\n![Diagram]");
  for (const [name, asset] of Object.entries(prepared.assets)) await writeFile(join(dirname(input), name), Buffer.from(asset as string, "base64"));
  for (const asset of Object.values(prepared.assets) as string[]) {
    const svg = Buffer.from(asset, "base64").toString(); expect(svg).toContain("<svg"); expect(svg).not.toContain("<foreignObject");
  }
});

test("Source mode preserves wrapping, caret status, code folds and undo across view changes", async ({ page }) => {
  await page.setViewportSize({width: 1120, height: 780});
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => { if (command === "document_changed") (window as any).lastChangedSource = JSON.parse(args).content; queueMicrotask(() => window.supermdReply?.(id, true, null)); } }; });
  await page.goto("/android-reader.html");
  const content = "# Source workspace\n\n```python\n" + Array.from({length: 20}, (_, i) => `print('line ${i}')`).join("\n") + "\n```\n";
  await page.evaluate(content => window.supermdLoad?.({id:"source-ui-test",content,path:null,mode:"editor",dark:true,fullscreen:false,colors:{},font:"sans",size:18,zoom:100}),content);
  await expect(page.locator(".source-editor-status")).toBeVisible();
  await expect(page.getByRole("button", {name:"Wrap lines"})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("button", {name:"Wrap lines"}).click();
  await expect(page.locator(".cm-content")).toHaveCSS("white-space","pre");
  await expect(page.locator(".cm-foldGutter")).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End"); await page.keyboard.type("Saved selection");
  await expect(page.locator(".source-position")).toContainText("Ln 25");
  await expect(page.locator(".cm-content")).toContainText("Saved selection");
  // Keep the current edited source while switching to Read and back.
  const edited = await page.evaluate(() => (window as any).lastChangedSource as string);
  await page.evaluate(content => window.supermdLoad?.({id:"source-ui-test",content,path:null,mode:"reader",dark:true,fullscreen:false,colors:{},font:"sans",size:18,zoom:100}),edited);
  await expect(page.locator(".source-editor-status")).toHaveCount(0);
  await page.evaluate(content => window.supermdLoad?.({id:"source-ui-test",content,path:null,mode:"editor",dark:true,fullscreen:false,colors:{},font:"sans",size:18,zoom:100}),edited);
  await expect(page.getByRole("button", {name:"Wrap lines"})).toHaveAttribute("aria-pressed","false");
  await expect(page.locator(".cm-content")).toHaveCSS("white-space","pre");
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+z");
  await expect(page.locator(".cm-content")).not.toContainText("Saved selection");
  // The syntax palette must not override Material/system editor surfaces.
  await page.evaluate(content => window.supermdLoad?.({id:"source-ui-test",content,path:null,mode:"editor",dark:true,fullscreen:false,colors:{surface:"#170e09",text:"#ffe8d9"},font:"sans",size:18,zoom:100}),content);
  await expect(page.locator(".cm-editor")).toHaveCSS("background-color","rgb(23, 14, 9)");
  await expect(page.locator(".cm-gutters")).toHaveCSS("background-color","rgb(23, 14, 9)");
  await page.evaluate(content => window.supermdLoad?.({id:"source-ui-test",content,path:null,mode:"editor",dark:false,fullscreen:false,colors:{surface:"#fff8f5",text:"#201a17"},font:"sans",size:18,zoom:100}),content);
  await expect(page.locator(".cm-editor")).toHaveCSS("background-color","rgb(255, 248, 245)");
  await expect(page.getByRole("button", {name:"Wrap lines"})).toHaveAttribute("aria-pressed","false");
  await page.screenshot({path:test.info().outputPath("source-workspace.png")});
});

test("plot pinch and trackpad zoom are independent of document text and export the selected view", async ({page}) => {
  const requests: Array<{command:string;args:any}> = [];
  await page.exposeFunction("bridgePost", (id:string,command:string,raw:string) => {
    requests.push({command,args:JSON.parse(raw)});
    void page.evaluate(id=>window.supermdReply?.(id,true,null),id);
  });
  await page.addInitScript(()=> { window.SuperMD={post:(id,command,args)=>(window as any).bridgePost(id,command,args)}; });
  await page.goto("/android-reader.html");
  const line=JSON.stringify({title:"Line plot",series:[{expression:"sin(x)"}]});
  const surface=JSON.stringify({mode:"surface3d",title:"Surface plot",series:[{expression:"x^2+y^2"}],x:{min:-2,max:2,steps:12},y:{min:-2,max:2}});
  const content=`# Plots\n\n\`\`\`smd-chart\n${line}\n\`\`\`\n\n\`\`\`smd-chart\n${surface}\n\`\`\``;
  await page.evaluate(content=>window.supermdLoad?.({id:"plot-zoom",content,path:null,mode:"reader",dark:false,fullscreen:false,colors:{},font:"sans",size:18,zoom:100}),content);
  const plots=page.locator(".interactive-chart"); await expect(plots).toHaveCount(2);
  await page.setViewportSize({width:420,height:900});
  await expect.poll(()=>plots.first().locator("svg").evaluate(svg=>{
    const box=(svg as SVGSVGElement).viewBox.baseVal,rect=svg.getBoundingClientRect();return rect.width/box.width;
  })).toBeGreaterThan(.9);
  expect(await plots.first().locator("svg").evaluate(svg=>{
    const label=svg.querySelector("text")!,rect=svg.getBoundingClientRect();return Number.parseFloat(getComputedStyle(label).fontSize)*rect.width/(svg as SVGSVGElement).viewBox.baseVal.width;
  })).toBeGreaterThan(11);
  await page.setViewportSize({width:1280,height:900});
  for (let index=0;index<2;index++) {
    await plots.nth(index).locator("svg").evaluate(target=> {
      const touches=(x:number)=>[new Touch({identifier:1,target,clientX:60,clientY:140}),new Touch({identifier:2,target,clientX:x,clientY:140})];
      target.dispatchEvent(new TouchEvent("touchstart",{bubbles:true,cancelable:true,touches:touches(160)}));
      target.dispatchEvent(new TouchEvent("touchmove",{bubbles:true,cancelable:true,touches:touches(240)}));
      target.dispatchEvent(new TouchEvent("touchend",{bubbles:true,touches:[]}));
    });
    await expect(plots.nth(index)).toHaveAttribute("data-plot-zoom","1.8");
    expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--workspace-scale"))).toBe("1");
  }
  await plots.first().locator("svg").dispatchEvent("wheel",{ctrlKey:true,deltaY:-120});
  await expect.poll(()=>plots.first().getAttribute("data-plot-zoom").then(Number)).toBeGreaterThan(1.8);
  expect(requests.some(request=>request.command==="zoom_changed")).toBe(false);
  await page.evaluate(()=>window.supermdExport?.({pageSize:"a4",margin:18,fontSize:11,fontFamily:"Noto Sans",lineHeight:1.35,pageNumbers:false}));
  await expect.poll(()=>requests.some(request=>request.command==="export_pdf_native")).toBeTruthy();
  const exported=requests.find(request=>request.command==="export_pdf_native")!.args;
  expect(Object.keys(exported.assets)).toHaveLength(2);
  const snapshots=Object.values(exported.assets).map(asset=>Buffer.from(asset as string,"base64").toString());
  expect(snapshots.some(svg=>svg.includes("Plot zoom: 180%"))).toBe(true);
  expect(snapshots.some(svg=>svg.includes("clip-path=\"url(#surface-") && svg.includes('height="440"'))).toBe(true);
  await expect(plots.first().getByRole("button",{name:"Reset zoom",exact:true})).toHaveCount(0);
  await expect(plots.first().getByRole("slider",{name:"Plot zoom"})).toHaveCount(0);
  await expect(plots.nth(1)).toHaveAttribute("data-plot-zoom","1.8");
  // A previously focused chart must not also zoom when the pointer is over another.
  await plots.nth(1).locator("svg").focus();
  await plots.first().locator("svg").hover();
  const before=Number(await plots.first().getAttribute("data-plot-zoom"));
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("supermd-chart-native-zoom",{detail:2,cancelable:true})));
  await expect.poll(()=>plots.first().getAttribute("data-plot-zoom").then(Number)).toBeCloseTo(before*2);
  await expect(plots.nth(1)).toHaveAttribute("data-plot-zoom","1.8");
});

test("click-to-edit, media drops, titled links and portable source work together", async ({ page }) => {
  const calls: Array<{ command: string; args: any }> = []; const assets = new Map<string, string>(); let sequence = 0;
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw); calls.push({ command, args });
    let result: any = true;
    if (command === "import_images") result = args.images.map((image: any) => { const source = `assets/import-test-${++sequence}.${image.data.startsWith("data:image/svg") ? "svg" : "jpg"}`; assets.set(source, image.data); return { source, alt: image.name }; });
    if (command === "load_asset") result = assets.get(args.source);
    if (command === "fetch_resource") result = { body: args.image ? "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="blue"/></svg>').toString("base64") : JSON.stringify({ title: "Understanding Fourier series", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }) };
    void page.evaluate(({ id, result }) => window.supermdReply?.(id, result, null), { id, result });
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto("/android-reader.html");
  await page.evaluate(() => window.supermdLoad?.({ id: "media-note", content: '# Study notes\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><circle cx="50" cy="25" r="20" fill="blue"/></svg>\n```', path: "media-note", mode: "live", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }));
  await expect(page.locator(".live-edit-button")).toHaveCount(0); await expect(page.locator(".svg-diagram")).toBeVisible();
  await page.getByRole("heading", { name: "Study notes" }).click(); await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveCount(0);
  await page.getByRole("heading", { name: "Study notes" }).dblclick(); await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toContainText("# Study notes");
  await page.evaluate(() => { const editor = document.querySelector('textarea')!; const clipboard = new DataTransfer(); clipboard.setData("text/plain", "https://youtu.be/dQw4w9WgXcQ"); editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true })); });
  await expect(page.getByRole("dialog", { name: "Insert image or link" })).toBeVisible(); await expect(page.getByLabel("Link title")).toHaveValue("Understanding Fourier series");
  await page.getByLabel("Include the video thumbnail").check(); await page.getByRole("button", { name: "Insert link", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => calls.filter((call) => call.command === "document_changed").at(-1)?.args.content).toContain("[Understanding Fourier series](<https://youtu.be/dQw4w9WgXcQ>)");
  // Live textarea exits on blur; switch explicitly to reading for DOM file drop.
  const current = calls.filter((call) => call.command === "document_changed").at(-1)!.args.content;
  await page.evaluate((content) => window.supermdLoad?.({ id: "media-note", content, path: "media-note", mode: "reader", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), current);
  await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M0 0L40 40" stroke="red"/></svg>'], "Dropped.svg", { type: "image/svg+xml" })); document.querySelector('.android-reading')!.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })); });
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toBeVisible();
  // Contextual tools only appear on selection; removal is reversible and
  // changes editable Markdown rather than an opaque portable envelope.
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await page.getByRole("img", { name: "Dropped.svg" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toBeVisible();
  await page.evaluate(() => window.supermdPortable?.(false));
  await expect.poll(() => calls.some((call) => call.command === "export_fmd_native")).toBeTruthy();
  const bundle = calls.find((call) => call.command === "export_fmd_native")!.args;
  expect(Object.keys(bundle.assets)).toHaveLength(2); expect(bundle.content).not.toContain("base64"); expect(bundle.content).toContain("```svg");
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  await expect.poll(() => calls.some((call) => call.command === "export_pdf_native")).toBeTruthy();
  expect(calls.find((call) => call.command === "export_failed")).toBeUndefined();
  const pdf = calls.find((call) => call.command === "export_pdf_native")!.args;
  expect(Object.keys(pdf.assets)).toHaveLength(3); expect(pdf.content).not.toContain("```svg");
  await page.screenshot({ path: test.info().outputPath("media-and-vectors.png") });
});

test("editable zoom and one export chooser work at desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await page.goto("/");
  const zoom = page.getByRole("textbox", { name: "Zoom percentage", exact: true });
  await zoom.fill("175"); await zoom.press("Enter"); await expect(zoom).toHaveValue("175");
  const chromeHeight = await page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().height);
  await page.keyboard.press("F11");
  await expect(page.locator(".fullscreen-controls input")).toHaveValue("100");
  await page.locator(".fullscreen-controls input").fill("210"); await page.locator(".fullscreen-controls input").press("Enter");
  await page.keyboard.press("F11"); await expect(zoom).toHaveValue("175");
  expect(await page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().height)).toBe(chromeHeight);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export your note" })).toBeVisible();
  await page.getByRole("button", { name: "Portable FMD", exact: true }).click();
  await expect(page.getByText("One editable file", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Page numbers", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "PDF document", exact: true }).click();
  await expect(page.getByLabel("Page numbers", { exact: true })).toBeVisible();
  await expect.poll(async () => page.locator('.export-format-indicator').evaluate((node) => Math.abs(node.getBoundingClientRect().left - node.parentElement!.querySelector('button')!.getBoundingClientRect().left))).toBeLessThan(4);
  await page.screenshot({ path: test.info().outputPath("desktop-export.png") });
  await page.getByRole("button", { name: "Close export settings" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Reading size", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Reading size", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Reading size (18px)", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Expressive motion", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await expect(page.locator("smd-expressive-button.export-action")).toHaveAttribute("motion-off", "");
  await expect(page.locator("smd-slider").first()).toHaveAttribute("motion-off", "");
  expect(await page.getByRole("switch", { name: "Autosave", exact: true }).evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
  await page.screenshot({ path: test.info().outputPath("desktop-material-settings.png") });
});

test("Obsidian multiline display math preserves the full study document", async ({ page }) => {
  const markdown = process.env.SUPERMD_OBSIDIAN_NOTE ? await readFile(process.env.SUPERMD_OBSIDIAN_NOTE, "utf8") : String.raw`# Probability

$$\boxed{\begin{aligned}
P(A\cup B)=&P(A)+P(B)\\
&-P(A\cap B).
\end{aligned}}$$

**Proof:** Preserved explanation.

> [!TIP] Learn
> $$P(A\cap B)\le1$$

## The rest of the document

| Formula | Meaning |
|---|---|
| $P(A\cap B)$ | Both events |
`;
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    calls.push({ command, args: JSON.parse(raw) }); void page.evaluate((id) => window.supermdReply?.(id, true, null), id);
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto('/android-reader.html');
  const expectedHeadings = (markdown.match(/^#{1,6}\s/gm) || []).length;
  for (const mode of ["reader", "live"] as const) {
    await page.evaluate(({ content, mode }) => window.supermdLoad?.({ id: "math-note", content, mode, path: null, dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), { content: markdown, mode });
    await expect(page.locator('.katex-display').first()).toBeVisible();
    await expect(page.locator('.katex-error')).toHaveCount(0);
    await expect(page.locator('.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6')).toHaveCount(expectedHeadings);
    expect(await page.locator('.katex').count()).toBeGreaterThan(2);
  }
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  await expect.poll(() => calls.some((call) => call.command === 'export_pdf_native')).toBeTruthy();
  expect(calls.find((call) => call.command === 'export_failed')).toBeUndefined();
});

test("Material menus, expressive toolbar and fractional-scale surfaces", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("setup.complete", "true"));
  await page.goto("http://127.0.0.1:1420/");
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.locator(".preview-pane")).toHaveCSS("border-top-width", "0px");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const theme = page.getByRole("combobox", { name: "Normal theme", exact: true });
  await theme.click(); await expect(page.getByRole("option", { name: "Material dark", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Material dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("combobox", { name: "Reading font", exact: true }).click();
  await page.getByRole("option", { name: "Manrope · expressive", exact: true }).click();
  await page.evaluate(() => { (window as any).testMenuOpened = false; document.querySelector('smd-select')!.addEventListener('opened', () => { (window as any).testMenuOpened = true; }, { once: true }); });
  await theme.click(); await expect.poll(() => page.evaluate(() => (window as any).testMenuOpened)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("material-menu-125percent.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("combobox", { name: "Page size", exact: true }).click();
  await page.getByRole("option", { name: "US Letter", exact: true }).click();
  await expect(page.locator('smd-select').filter({ has: page.getByRole("combobox", { name: "Page size", exact: true }) })).toHaveJSProperty("value", "letter");
  await page.getByRole("button", { name: "Close export settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.locator(".topbar").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator(".brand").evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(150);
  await page.screenshot({ path: test.info().outputPath("expressive-workspace-125percent.png") });
  await context.close();
});
