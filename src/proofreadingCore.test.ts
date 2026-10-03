import {expect,it} from "vitest";
import nspell from "nspell";
import aff from "../node_modules/dictionary-en/index.aff?raw";
import dic from "../node_modules/dictionary-en/index.dic?raw";
import {proseMask,writingIssues} from "./proofreadingCore";
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
