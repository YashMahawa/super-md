import {expect,it} from "vitest";
import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {remarkObsidianMath} from "./obsidianMath";
import {tableMathPipeInsertions} from "./tableMath";
it("keeps absolute values and conditional probabilities inside table cells with original offsets",()=>{
  const source=String.raw`| First | Second |
|---|---|
| $P(|X_n-X|>\varepsilon)\to0$ | $F_n(x)$ |
| $P(A|B)$ and $\left|x\right|$ | unchanged |`;
  const tree:any=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).parse(source);
  const table=tree.children[0];expect(table.type).toBe("table");
  expect(table.children.every((r:any)=>r.children.length===2)).toBe(true);
  const formula=table.children[1].children[0].children[0];
  expect(formula.type).toBe("inlineMath");expect(formula.value).toBe(String.raw`P(|X_n-X|>\varepsilon)\to0`);
  expect(source.slice(formula.position.start.offset,formula.position.end.offset)).toBe(String.raw`$P(|X_n-X|>\varepsilon)\to0$`);
});
it("does not rewrite non-tables, escaped pipes or code",()=>{
  expect(tableMathPipeInsertions(String.raw`$|x|$ costs $20.

~~~md
| x | y |
|---|---|
| $|x|$ | z |
~~~

| x | y |
|---|---|
| $\lvert x\rvert$ | `+"`$|x|$` |" )).toEqual([]);
});
