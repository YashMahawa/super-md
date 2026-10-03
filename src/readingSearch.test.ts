import {describe,it,expect} from "vitest";
import {replaceSourceMatches,sourceMatches} from "./components/ReadingSearch";
describe("source search",()=>{
  it("finds offscreen source, preserves case and literal punctuation",()=>{
    const content="A.b\n"+"long note\n".repeat(3000)+"a.B";
    expect(sourceMatches(content,"a.b")).toEqual([{from:0,to:3},{from:content.length-3,to:content.length}]);
    expect(sourceMatches(content,"A.b",true)).toEqual([{from:0,to:3}]);
  });
  it("replaces literal text, not replacement dollar expressions or regex",()=>{
    expect(replaceSourceMatches("$x$ and $X$","$x$","$1 \\alpha",false,1)).toBe("$x$ and $1 \\alpha");
    expect(replaceSourceMatches("same SAME same","same","new",true)).toBe("new SAME new");
  });
});
