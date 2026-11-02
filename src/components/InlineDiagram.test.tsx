// @vitest-environment jsdom
import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import InlineDiagram,{parseDiagramSource} from "./InlineDiagram";
import {parseBinaryTree,parseBinaryTreeSource} from "./BinaryTree";
import MarkdownPreview from "./MarkdownPreview";
const tree={title:"A heap with one left child",values:["50","30","40","10","20","35"],highlight:[5]};
const fence=String.fromCharCode(96).repeat(3);
describe("declarative diagrams",()=>{
 it("keeps single left child slanted, not vertically beneath parent",()=>{
  const g=parseBinaryTree(tree)!;expect(g).not.toBeNull();
  const parent=g.nodes.find(n=>n.id==="n2")!;
  const child=g.nodes.find(n=>n.id==="n5")!;
  expect(child.x).toBeLessThan(parent.x);
  expect(child.y).toBeGreaterThan(parent.y);
  expect(g.edges).toContainEqual({from:"n2",to:"n5",dashed:false});
 });
 it("places a lone RIGHT child on the right, preserving the missing left slot",()=>{
  const g=parseBinaryTree({values:["50",null,"40"]})!;
  expect(g.nodes.find(n=>n.id==="n2")!.x).toBeGreaterThan(g.nodes.find(n=>n.id==="n0")!.x);
  expect(g.edges).toContainEqual({from:"n0",to:"n2",dashed:false});
 });
 it("rejects invalid or orphan nodes and executable markup",()=>{
  expect(parseBinaryTree({values:["A",null,null,null,"invalid"]})).toBeNull();
  expect(parseBinaryTree({values:[null]})).toBeNull();
  const s=renderToStaticMarkup(<InlineDiagram diagram={parseBinaryTree({values:["<script>"]})}/>);
  expect(s).not.toContain("<script>");
  expect(s).toContain("&lt;script&gt;");
  expect(parseDiagramSource('{"nodes":[]}')).toBeNull();
 });
 it("renders both native diagram fences through the shared Markdown preview",()=>{
  const full=JSON.stringify(tree);
  const html=renderToStaticMarkup(<MarkdownPreview markdown={fence+"smd-tree\n"+full+"\n"+fence} documentPath={null} python="" dark/>);
  expect(html).toContain("inline-diagram-node");
  expect(html).toContain("translate(375 260)");
  expect(parseBinaryTreeSource(full)).not.toBeNull();
 });
 it("supports an inline tree per step without images",()=>{
  const source=JSON.stringify({title:"A changing heap",steps:[
    {label:"First",diagram:{values:["10","5","7"]}},
    {label:"Second",diagram:{values:["10","7","5"]}}
  ]});
  const html=renderToStaticMarkup(<MarkdownPreview markdown={fence+"smd-steps\n"+source+"\n"+fence} documentPath={null} python="" dark/>);
  expect(html).toContain("step-cards-inline-figure");
  expect(html).toContain("inline-diagram-node");
  expect(html).not.toContain("step-cards-figure-stack");
 });
});
