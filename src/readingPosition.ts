/** Source offsets survive switching between reflowed reading and source views. */
import {revealWindowed} from "./windowedSearch";
export function readingOffset(root:HTMLElement):number {
  const top=root.getBoundingClientRect().top+16;
  const blocks=Array.from(root.querySelectorAll<HTMLElement>(".live-block,[data-source-start]"));
  const block=blocks.find(node=>{const r=node.getBoundingClientRect();return r.bottom>top&&r.height>0;});
  if(!block)return 0;
  const owner=block.closest<HTMLElement>(".live-block");
  return Number((owner||block).dataset.sourceStart)||0;
}
export function revealReadingOffset(root:HTMLElement,offset:number):void {
  const blocks=Array.from(root.querySelectorAll<HTMLElement>(".live-block,[data-source-start]"));
  let best:HTMLElement|undefined;
  for(const block of blocks){
    if(block.closest(".live-block")&&!block.matches(".live-block"))continue;
    const start=Number(block.dataset.sourceStart),end=Number(block.dataset.sourceEnd);
    if(start<=offset){best=block;if(end>=offset)break;}
  }
  if(best){revealWindowed(best);best.scrollIntoView({block:"start",behavior:"instant"});}
}
