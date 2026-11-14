// @vitest-environment jsdom
import {afterEach, expect, it, vi} from "vitest";
const {invoke} = vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("./nativeBridge",()=>({invoke}));
import {preparePdf} from "./preparePdf";
afterEach(()=>invoke.mockReset());

it("exports every image in a sequence, preserving labels, captions and surrounding blocks",async()=>{
  invoke.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
  const steps = Array.from({length:7},(_,i)=>({label:`Stage ${i+1}`,image:`assets/${i}.svg`,description:`Caption ${i+1}`}));
  const source = '# Before\n\n```smd-steps\n'+JSON.stringify({title:'Sequence',steps})+'\n```\n\n## After\n\nText.';
  const result=await preparePdf(source,'/notes/a.smd');
  expect(invoke).toHaveBeenCalledTimes(7);
  expect(Object.keys(result.assets)).toHaveLength(7);
  const grid=JSON.parse(/```smd-step-grid\n([\s\S]*?)\n```/.exec(result.content)![1]);
  expect(grid.steps.map((s:any)=>s.label)).toEqual(steps.map(s=>s.label));
  for(const step of grid.steps)expect(result.assets[step.image]).toBe('PHN2Zy8+');
  expect(result.content).toContain('\n\n## After\n\n');
  expect(source).toContain('```smd-steps');
});

it("prepares declarative diagrams and charts as actual print SVGs",async()=>{
  const diagram={width:240,height:100,nodes:[{id:'a',label:'A',x:60,y:50},{id:'b',label:'B',x:180,y:50,state:'active'}],edges:[{from:'a',to:'b'}]};
  const chart={title:'Line',xRange:[-2,2],yRange:[-2,2],series:[{expression:'x'}]};
  const source='```smd-steps\n'+JSON.stringify({title:'Mixed',steps:[{label:'Nodes',diagram},{label:'Plot',chart},{label:'Interpretation',description:'A plain text frame'}]})+'\n```';
  const result=await preparePdf(source,null);
  expect(Object.keys(result.assets)).toHaveLength(2);
  const svg=atob(Object.values(result.assets)[0]);
  expect(svg).toContain('stroke="#667085"');
  expect(svg).toContain('fill="#ffb367"');
  expect(result.content).toContain('A plain text frame');
});

it("reports malformed decks rather than printing their raw JSON",async()=>{
  await expect(preparePdf('```smd-steps\n{"steps":[]}\n```',null)).rejects.toThrow('Invalid step cards');
});

it("keeps step Markdown and LaTeX as formatted export content",async()=>{
  const source='```smd-steps\n'+JSON.stringify({title:'Calculation',steps:[{label:'Mean',markdown:'**Result**\n\n$$x=3$$'},{label:'Interpretation',markdown:'- First item\n- Second item'}]})+'\n```';
  const prepared=await preparePdf(source,null);
  const grid=JSON.parse(/```smd-step-grid\n([\s\S]*?)\n```/.exec(prepared.content)![1]);
  expect(grid.steps[0].markdown).toContain('**Result**');
  expect(grid.steps[0].markdown).toContain('$$');
  expect(grid.steps[1].markdown).toContain('First item');
});
