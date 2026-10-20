import {describe,it,expect,vi} from 'vitest';
import {ReaderEdits,sourceChanges} from './readerEdits';

describe('reader edit transport',()=>{
  it('uses UTF-16 boundaries without splitting emoji',()=>{
    expect(sourceChanges('a😀z','a😁z')).toEqual([{from:1,to:3,insert:'😁'}]);
    expect(sourceChanges('a\r\nz','a\r\n!z')).toEqual([{from:3,to:3,insert:'!'}]);
  });
  it('coalesces queued edits behind acknowledgements',async()=>{
    let release!:(value:any)=>void;
    const send=vi.fn(async(command:string,args:any)=>command==='document_sync'?await new Promise<any>(resolve=>release=resolve):{accepted:true,revision:args.revision});
    const edits=new ReaderEdits(send);edits.open('note','a');
    const first=edits.change('note','ab');edits.change('note','abc');
    release({accepted:true,revision:0});await first;await edits.flush('note');
    expect(send.mock.calls.map(call=>call[0])).toEqual(['document_sync','document_patch']);
    expect(send.mock.calls[1][1].changes).toEqual([{from:1,to:1,insert:'bc'}]);
  });
  it('stops a flush on native divergence instead of overwriting',async()=>{
    const send=vi.fn(async(_command:string,_args:Record<string,unknown>)=>({accepted:false}));const edits=new ReaderEdits(send);edits.open('note','a');
    await expect(edits.change('note','b')).rejects.toThrow('outside');
    await expect(edits.flush('note')).rejects.toThrow();
    expect(send.mock.calls.every(call=>['document_sync','document_resync'].includes(call[0]))).toBe(true);
  });
  it('uses both possible native bases after a lost acknowledgement',async()=>{
    const send=vi.fn(async(command:string)=>{if(command==='document_patch')throw new Error('lost');return {accepted:true,revision:0};});
    const edits=new ReaderEdits(send);edits.open('note','a');await edits.change('note','b');
    expect((send.mock.calls[2] as any)[1]).toMatchObject({bases:['a','b'],content:'b'});
  });
});
