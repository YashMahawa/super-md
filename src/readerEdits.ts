export interface SourceChange {from:number;to:number;insert:string}
type Reply={accepted:boolean;revision?:number};
type Send=(command:string,args:Record<string,unknown>)=>Promise<Reply>;
interface Session {id:string;epoch:string;ack:string;latest:string;revision:number;ready:boolean;running?:Promise<void>;error?:Error;pending?:{before:string;after:string;changes:SourceChange[]}}

/** One acknowledged transaction at a time; never fall back to a blind overwrite. */
export class ReaderEdits {
  private sessions=new Map<string,Session>();
  constructor(private send:Send){}
  open(id:string,content:string){
    // Inactive acknowledged sessions can be re-synchronized on revisit. Do
    // not retain forty large source snapshots merely to keep revision numbers.
    for(const [key,value] of this.sessions)if(key!==id&&!value.running&&value.latest===value.ack)this.sessions.delete(key);
    const existing=this.sessions.get(id);
    if(existing&&(existing.latest===content||existing.running))return;
    this.sessions.set(id,{id,epoch:crypto.randomUUID(),ack:content,latest:content,revision:0,ready:false});
    // Only inactive, settled sessions may be evicted. Notes remain native-owned.
    for(const [key,value] of this.sessions){if(this.sessions.size<=40)break;if(key!==id&&!value.running&&value.latest===value.ack)this.sessions.delete(key);}
  }
  unacknowledged(id:string){const session=this.sessions.get(id);return session&&session.latest!==session.ack?session.latest:undefined;}
  change(id:string,content:string,changes?:SourceChange[]){
    const session=this.sessions.get(id);if(!session)throw new Error('No document edit session');
    session.pending=changes?{before:session.latest,after:content,changes}:undefined;
    session.latest=content;
    return this.pump(session);
  }
  async flush(id:string){
    const session=this.sessions.get(id);if(!session)return;
    await this.pump(session);
    if(session.error)throw session.error;
  }
  private pump(session:Session):Promise<void>{
    if(session.running)return session.running;
    session.running=this.drain(session).finally(()=>{session.running=undefined;});
    return session.running;
  }
  private async drain(session:Session){
    try{
      if(!session.ready){
        const reply=await this.send('document_sync',{id:session.id,epoch:session.epoch,revision:0,content:session.ack});
        if(!reply.accepted){
          const draft=session.latest;
          const recovery=await this.send('document_resync',{id:session.id,epoch:session.epoch,revision:0,bases:[session.ack],content:draft});
          if(!recovery.accepted)throw new Error('The document changed outside this edit session. Your unsent text is still in the editor.');
          session.ack=draft;session.revision=0;
        }
        session.ready=true;
      }
      while(session.latest!==session.ack){
        const before=session.ack,after=session.latest,revision=session.revision+1;
        const pending=session.pending;
        const changes=pending?.before===before&&pending.after===after?pending.changes:sourceChanges(before,after);
        const args={id:session.id,epoch:session.epoch,baseRevision:session.revision,revision,changes};
        let reply:Reply;
        try{reply=await this.send('document_patch',args);}
        catch{reply={accepted:false};}
        if(!reply.accepted||reply.revision!==revision){
          // Native may already have applied the transaction when its reply was lost.
          const recovered=session.latest;
          reply=await this.send('document_resync',{id:session.id,epoch:session.epoch,revision:0,bases:[before,after],content:recovered});
          if(!reply.accepted)throw new Error('Edit acknowledgement failed. Your unsent text is still in the editor; save/close was stopped.');
          session.ack=recovered;session.revision=0;continue;
        }
        session.ack=after;session.revision=revision;
        if(session.pending?.after===after)session.pending=undefined;
      }
      if(session.pending?.after===session.ack)session.pending=undefined;
      session.error=undefined;
    }catch(error){session.error=error instanceof Error?error:new Error(String(error));throw session.error;}
  }
}

export function sourceChanges(before:string,after:string):SourceChange[]{
  let start=0,endBefore=before.length,endAfter=after.length;
  while(start<endBefore&&start<endAfter&&before.charCodeAt(start)===after.charCodeAt(start))start++;
  // Do not cut between the halves of an astral character.
  if(start>0&&start<before.length&&before.charCodeAt(start)>=0xdc00&&before.charCodeAt(start)<=0xdfff)start--;
  while(endBefore>start&&endAfter>start&&before.charCodeAt(endBefore-1)===after.charCodeAt(endAfter-1)){endBefore--;endAfter--;}
  if(endBefore<before.length&&endBefore>start&&before.charCodeAt(endBefore)>=0xdc00&&before.charCodeAt(endBefore)<=0xdfff){endBefore++;endAfter++;}
  return [{from:start,to:endBefore,insert:after.slice(start,endAfter)}];
}
