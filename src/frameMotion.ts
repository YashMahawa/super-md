/** Keep easing duration in milliseconds, rather than speeding it up on a
 * 120/144 Hz display. Frames themselves come from the host's vsync RAF. */
export function zoomFrameStep(current:number,target:number,elapsed:number):number {
  const next=current+(target-current)*(1-Math.pow(.68,Math.max(0,Math.min(100,elapsed))/(1000/60)));
  return Math.abs(target-next)<.08?target:next;
}

/** Touchpads can deliver several native events between display frames. Apply
 * all their distance once per frame instead of crossing layout/anchors for
 * every input event. No fixed-Hz timer and no animation while idle. */
export class FrameScrollQueue {
  private pending=new Map<HTMLElement,{x:number;y:number}>();
  private frame=0;
  constructor(private apply:(root:HTMLElement,x:number,y:number)=>void,
    private request:(callback:FrameRequestCallback)=>number=callback=>requestAnimationFrame(callback),
    private cancel:(frame:number)=>void=frame=>cancelAnimationFrame(frame)){}
  scroll(root:HTMLElement,x:number,y:number):void {
    if(!Number.isFinite(x)||!Number.isFinite(y)||(!x&&!y))return;
    const delta=this.pending.get(root)??{x:0,y:0};delta.x+=x;delta.y+=y;this.pending.set(root,delta);
    if(!this.frame)this.frame=this.request(()=>{this.frame=0;const batch=this.pending;this.pending=new Map();for(const [node,d]of batch)if(node.isConnected)this.apply(node,d.x,d.y);});
  }
  clear():void {if(this.frame)this.cancel(this.frame);this.frame=0;this.pending.clear();}
}
