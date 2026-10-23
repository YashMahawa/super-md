import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

class FakeWorker {
  static instances:FakeWorker[]=[];
  onmessage:((event:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null;
  sent:Array<{id:number}>=[];
  terminate=vi.fn();
  constructor(){FakeWorker.instances.push(this);}
  postMessage(value:{id:number}){this.sent.push(value);}
  reply(index:number,issues:unknown[]=[]){this.onmessage?.({data:{id:this.sent[index].id,issues}});}
}

describe('proofreading worker ownership and idle eviction',()=>{
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();FakeWorker.instances=[];vi.stubGlobal('Worker',FakeWorker);});
  afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

  it('does not load a worker when assistance is disabled',async()=>{
    const {checkWriting}=await import('./proofreading');
    expect(await checkWriting('Text',{})).toEqual([]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('lets cold startup finish after the idle interval, then evicts only after actual idle time',async()=>{
    const {checkWriting}=await import('./proofreading');
    const result=checkWriting('sentnce',{spellCheck:true});
    const owner=FakeWorker.instances[0];
    let completed=false;void result.then(()=>{completed=true;});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.terminate).not.toHaveBeenCalled();expect(completed).toBe(false);
    const issues=[{from:0,to:7,message:'Possible spelling error',kind:'spelling',replacements:['sentence']}];
    owner.reply(0,issues);expect(await result).toEqual(issues);
    await vi.advanceTimersByTimeAsync(44_999);expect(owner.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(owner.terminate).toHaveBeenCalledOnce();
  });

  it('does not evict with queued work and cancels an idle deadline for a new request',async()=>{
    const {checkWriting}=await import('./proofreading');
    const first=checkWriting('a apple',{grammarCheck:true});
    const second=checkWriting('the the',{grammarCheck:true});
    const owner=FakeWorker.instances[0];owner.reply(0);await first;
    await vi.advanceTimersByTimeAsync(60_000);expect(owner.terminate).not.toHaveBeenCalled();
    owner.reply(1);await second;
    await vi.advanceTimersByTimeAsync(40_000);
    const third=checkWriting('another check',{grammarCheck:true});
    await vi.advanceTimersByTimeAsync(20_000);expect(owner.terminate).not.toHaveBeenCalled();
    owner.reply(2);await third;
    await vi.advanceTimersByTimeAsync(45_000);expect(owner.terminate).toHaveBeenCalledOnce();
  });

  it('releases failed requests and ignores callbacks from a retired worker',async()=>{
    const {checkWriting}=await import('./proofreading');
    const first=checkWriting('old',{spellCheck:true});
    const old=FakeWorker.instances[0];old.onerror?.();expect(await first).toEqual([]);
    const next=checkWriting('new',{spellCheck:true});
    const current=FakeWorker.instances[1];old.onerror?.();old.reply(0);
    expect(current.terminate).not.toHaveBeenCalled();current.reply(0);expect(await next).toEqual([]);
  });
});
