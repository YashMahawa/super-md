import {expect,test} from "@playwright/test";

function buildLongTechnicalNote():string {
  const line="- Signal chains combine low-pass filters, Finite-duration windows, CLI-API bridges, and LaTeX-based equations cleanly.\n";
  const prefix="# Technical Signal Processing\n\n";
  const ending="- Concluding observation near the bottom with tehir actionable typo.\n";
  let body=prefix;
  while(body.length+ending.length<16_568){
    const remaining=16_568-body.length-ending.length;
    body+=remaining>=line.length?line:`${" ".repeat(Math.max(0,remaining-1))}\n`;
  }
  return (body+ending).slice(0,16_568);
}

test("caret-windowed proofreading checks 16,568-character technical notes without hyphen false positives and displays range badges",async({page})=>{
  const content=buildLongTechnicalNote();
  expect(content.length).toBe(16_568);

  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto("/android-reader.html");
  await page.waitForFunction(()=>typeof window.supermdLoad==="function");

  const baseState={id:"long-proofing",content,path:null,mode:"editor" as const,dark:false,fullscreen:false,colors:{},font:"Manrope",size:18,zoom:100,spellCheck:true,grammarCheck:true};
  await page.evaluate(state=>window.supermdLoad?.(state),baseState);

  await expect(page.locator(".source-proofreading-range")).toContainText("12,000-character range");
  await page.evaluate(offset=>window.dispatchEvent(new CustomEvent("supermd-goto-offset",{detail:offset})),content.length-20);
  await expect(page.locator(".cm-lintRange-info")).toHaveCount(1,{timeout:15_000});
  await expect(page.locator(".cm-lintRange-info")).toHaveText("tehir");

  // Switch to Live mode and edit the >16,500-character list block near the bottom.
  await page.evaluate(state=>window.supermdLoad?.({...state,mode:"live"}),baseState);
  await page.locator(".live-block").nth(1).dblclick();
  const textarea=page.getByRole("textbox",{name:"Edit Markdown block"});
  await expect(textarea).toBeFocused();
  await textarea.evaluate(el=>{
    const input=el as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new Event("select",{bubbles:true}));
  });

  const suggestions=page.getByRole("complementary",{name:"Writing suggestions"});
  await expect(suggestions).toBeVisible({timeout:15_000});
  await expect(suggestions.locator(".proofreading-range-badge")).toContainText("12,000-character range");
  await expect(suggestions.getByRole("button",{name:"their",exact:true})).toBeVisible({timeout:15_000});
  await expect(suggestions).not.toContainText("low-pass");
  await expect(suggestions).not.toContainText("Finite-duration");
  await expect(suggestions).not.toContainText("CLI-API");
  await expect(suggestions).not.toContainText("LaTeX-based");

  await suggestions.getByRole("button",{name:"their",exact:true}).click();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue(/with their actionable typo/);
});

test("suggestion queue dismissal preserves focus and personal dictionary persists across Live, Source and reloads",async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto("/android-reader.html");
  await page.waitForFunction(()=>typeof window.supermdLoad==="function");

  const content="# Domain Notes\n\nEigenmode coupling and eigenmode-based waveguides precede a apple, the the, sentnce, teh, adn, formn, and tehir.";
  const baseState={id:"dict-queue",content,path:null,mode:"live" as const,dark:false,fullscreen:false,colors:{},font:"Manrope",size:18,zoom:100,spellCheck:true,grammarCheck:true};
  await page.evaluate(state=>window.supermdLoad?.(state),baseState);

  await page.getByText("Eigenmode coupling",{exact:false}).dblclick();
  const textarea=page.getByRole("textbox",{name:"Edit Markdown block"});
  await expect(textarea).toBeFocused();

  const suggestions=page.getByRole("complementary",{name:"Writing suggestions"});
  await expect(suggestions).toBeVisible({timeout:15_000});
  await expect(suggestions.locator("header")).toContainText("6 of 10");

  // Ensure zero blank replacement buttons exist anywhere in the suggestions panel.
  const buttonLabels=await suggestions.locator("button").allTextContents();
  expect(buttonLabels.every(label=>label.trim().length>0)).toBe(true);

  // Save "Eigenmode" to personal dictionary: clears both "Eigenmode" and "eigenmode" in "eigenmode-based" without blurring textarea.
  await suggestions.getByRole("button",{name:"Add to dictionary",exact:true}).first().click();
  await expect(textarea).toBeFocused();
  await expect(suggestions.locator("header")).toContainText("6 of 8");
  await expect(suggestions).not.toContainText("Eigenmode");
  await expect(suggestions).not.toContainText("eigenmode");

  // Dismiss the first remaining issue and confirm focus stays in the block editor while queued issues advance.
  await expect(suggestions).not.toContainText("formn");
  await suggestions.getByRole("button",{name:"Dismiss",exact:true}).first().click();
  await expect(textarea).toBeFocused();
  await expect(suggestions.locator("header")).toContainText("6 of 7");
  await expect(suggestions).toContainText("formn");
  await suggestions.getByRole("button",{name:"Dismiss",exact:true}).first().click();
  await expect(textarea).toBeFocused();
  await expect(suggestions.locator("header")).toContainText("English · 6");
  await expect(suggestions).toContainText("tehir");

  // Switch to Source mode: "Eigenmode" / "eigenmode-based" must remain unflagged, and saving from Source tooltip works too.
  await textarea.press("Escape");
  await page.evaluate(state=>window.supermdLoad?.({...state,mode:"editor"}),baseState);
  await expect(page.locator(".cm-lintRange-info")).toHaveCount(8,{timeout:15_000});
  const flaggedTexts=await page.locator(".cm-lintRange-info").allTextContents();
  expect(flaggedTexts).not.toContain("Eigenmode");
  expect(flaggedTexts).not.toContain("eigenmode");

  // Hover over "formn" in Source mode to open the lint tooltip and save it to the personal dictionary.
  await page.locator(".cm-lintRange-info",{hasText:"formn"}).hover();
  const tooltip=page.locator(".cm-tooltip-lint");
  await expect(tooltip).toBeVisible({timeout:5_000});
  await tooltip.getByRole("button",{name:/Add to dictionary/}).click();
  await expect(page.locator(".cm-lintRange-info")).toHaveCount(7);
  expect(await page.locator(".cm-lintRange-info").allTextContents()).not.toContain("formn");

  // Reload the page and verify personal dictionary persistence across reloads.
  await page.reload();
  await page.waitForFunction(()=>typeof window.supermdLoad==="function");
  await page.evaluate(state=>window.supermdLoad?.({...state,mode:"editor"}),baseState);
  await expect(page.locator(".cm-lintRange-info")).toHaveCount(7,{timeout:15_000});
  const reloadedFlagged=await page.locator(".cm-lintRange-info").allTextContents();
  expect(reloadedFlagged).not.toContain("Eigenmode");
  expect(reloadedFlagged).not.toContain("eigenmode");
  expect(reloadedFlagged).not.toContain("formn");
});
