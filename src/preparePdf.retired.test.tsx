import {expect,it} from "vitest";
import {preparePdf} from "./preparePdf";
it("keeps retired interactive 3D source in PDF without executing or rewriting it",async()=>{
  const json=JSON.stringify({mode:"surface3d",series:[{expression:"x^2+y^2"}]});
  const content=`# Old note\n\n\`\`\`smd-chart\n${json}\n\`\`\``;
  const prepared=await preparePdf(content,null);
  expect(prepared.content).toContain(json);
  expect(prepared.content).toContain("```json");
  expect(prepared.assets).toEqual({});
  expect(content).toContain("```smd-chart");
});
