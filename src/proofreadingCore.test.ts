import {expect,it} from "vitest";
import nspell from "nspell";
import aff from "../node_modules/dictionary-en/index.aff?raw";
import dic from "../node_modules/dictionary-en/index.dic?raw";
import {PROOFREADING_MAX_CHARS,proseMask,selectProofreadingWindow,writingIssues,type Speller} from "./proofreadingCore";
it("offers local grammar corrections at exact source offsets",()=>{
  const source="😀 This is a apple and the the example.";
  const issues=writingIssues(source,{grammarCheck:true});
  expect(issues).toHaveLength(2);
  expect(issues.map(issue=>source.slice(issue.from,issue.to))).toEqual(["a","the the"]);
  expect(issues.map(issue=>issue.replacements[0])).toEqual(["an","the"]);
});
it("leaves Markdown code, links, image assets, HTML and math unchecked",()=>{
  const source="# Good writing\n\n`the the` $a a$ ![a apple](picture.png) [the the](https://example.com)\n\n```python\na apple\nthe the\n```\n\n$$\\text{the the}$$\n\n<div>the the</div>";
  expect(proseMask(source)).toContain("Good writing");
  expect(writingIssues(source,{grammarCheck:true})).toEqual([]);
});
it("uses a bundled real dictionary and skips reserved technical words",()=>{
  const dictionary=nspell(aff,dic);
  const source="This sentnce uses Matplotlib and LaTeX.";
  const issues=writingIssues(source,{spellCheck:true},dictionary);
  expect(issues).toHaveLength(1);
  expect(source.slice(issues[0].from,issues[0].to)).toBe("sentnce");
  expect(issues[0].replacements).toContain("sentence");
  expect(writingIssues(source,{},dictionary)).toEqual([]);
},15_000);
it("respects incremental editor code ranges even when a viewport starts inside a fence",()=>{
  expect(writingIssues("the the\n\na apple",{grammarCheck:true},undefined,[[0,7]])).toHaveLength(1);
});
it("validates hyphenated sub-words individually and preserves exact sub-word replacement offsets",()=>{
  const dictionary=nspell(aff,dic);
  const validSource="Signal chains use low-pass filters, Finite-duration windows, CLI-API bridges, and LaTeX-based typesetting.";
  expect(writingIssues(validSource,{spellCheck:true},dictionary)).toEqual([]);

  const typoSource="Check LaTeX-sentnce and well-tehir compounds.";
  const issues=writingIssues(typoSource,{spellCheck:true},dictionary);
  expect(issues.map(issue=>typoSource.slice(issue.from,issue.to))).toEqual(["sentnce","tehir"]);
  expect(issues[0].replacements).toContain("sentence");
  expect(issues[1].replacements).toContain("their");
  const fixed=typoSource.slice(0,issues[0].from)+issues[0].replacements[0]+typoSource.slice(issues[0].to);
  expect(fixed).toBe("Check LaTeX-sentence and well-tehir compounds.");
},15_000);
it("deduplicates repeated unknown words and curly apostrophes without exhausting candidate or suggestion quotas",()=>{
  const dictionary=nspell(aff,dic);
  const repeated=Array.from({length:36},(_,i)=>i%2===0?"dno’t":"Dno't").join(" ");
  const source=`${repeated} and downstream tehir typo.`;
  const issues=writingIssues(source,{spellCheck:true},dictionary);
  const tehirIssue=issues.find(issue=>source.slice(issue.from,issue.to)==="tehir");
  expect(tehirIssue).toBeDefined();
  expect(tehirIssue?.replacements).toContain("their");
  const apostropheIssue=issues.find(issue=>source.slice(issue.from,issue.to)==="dno’t");
  expect(apostropheIssue?.replacements).toContain("don't");
},15_000);
it("filters blank replacement strings and respects case-insensitive customWords",()=>{
  const speller:Speller={
    correct:word=>word!=="eigenmode"&&word!=="zorblax",
    suggest:word=>word==="zorblax"?["","   ","valid"]:[]
  };
  const source="An Eigenmode and Eigenmode’s behavior with zorblax.";
  const issues=writingIssues(source,{spellCheck:true,customWords:["eigenmode"]},speller);
  expect(issues).toHaveLength(1);
  expect(source.slice(issues[0].from,issues[0].to)).toBe("zorblax");
  expect(issues[0].replacements).toEqual(["valid"]);
});
it("centers a 12,000-character window around the cursor on a 16,568-character note and masks mid-fence code",()=>{
  const dictionary=nspell(aff,dic);
  const codeFence="```python\n" + Array.from({length:60},()=>"sentnce = 'a apple the the'\n").join("") + "```\n\n";
  const proseLine="A low-pass Finite-duration CLI-API LaTeX-based filter processes signals cleanly.\n";
  let body=`# Technical study\n\n${proseLine.repeat(42)}${codeFence}`;
  const ending="Final summary paragraph near the bottom with tehir actionable typo.\n";
  while(body.length+ending.length<16_568){
    const remaining=16_568-body.length-ending.length;
    body+=remaining>=proseLine.length?proseLine:" ".repeat(Math.max(0,remaining-1))+"\n";
  }
  const note=(body+ending).slice(0,16_568);
  expect(note.length).toBe(16_568);
  const win=selectProofreadingWindow(note,note.length-10);
  expect(win.truncated).toBe(true);
  expect(win.text.length).toBeLessThanOrEqual(PROOFREADING_MAX_CHARS);
  expect(win.to).toBe(16_568);
  const issues=writingIssues(win.text,{spellCheck:true,grammarCheck:true},dictionary,win.blocked)
    .map(issue=>({...issue,from:issue.from+win.from,to:issue.to+win.from}));
  expect(issues).toHaveLength(1);
  expect(note.slice(issues[0].from,issues[0].to)).toBe("tehir");
  expect(issues[0].replacements).toContain("their");
},15_000);
