import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ExportDownloads,EXPORT_CHUNK_BYTES,MAX_DOWNLOAD_BYTES} from './downloads.js';
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const meta=(data:Buffer,format='pdf')=>({downloadable:true,status:'completed',filename:'Study notes 猫.'+format,format,bytes:data.length,sha256:hash(data)});

test('only completed bounded exports receive expiring file capabilities',()=>{
 let now=1000;const downloads=new ExportDownloads(()=>now,100,2),data=Buffer.from('%PDF-1.7\n');
 for(const patch of [{downloadable:false},{status:'running'},{filename:'../private.pdf'},{bytes:MAX_DOWNLOAD_BYTES+1},{bytes:-1},{sha256:'bad'},{format:'txt'}])assert.equal(downloads.issue('g','d','j',{...meta(data),...patch}),null);
 const lease=downloads.issue('g','d','j',meta(data))!;assert.ok(lease.token.length>=32);assert.equal(downloads.issue('g','d','j',meta(data)),lease);
 assert.equal(downloads.issue('g','d','j2',meta(data))?.filename,'Study notes 猫.pdf');assert.equal(downloads.issue('g','d','j3',meta(data)),null);
 now+=101;assert.equal(downloads.get(lease.token),undefined);assert.ok(downloads.issue('g','d','new',meta(data)));
});

test('downloads stream bounded chunks and verify the complete artifact for every format',async()=>{
 for(const format of ['pdf','md','smd']){
  const data=Buffer.alloc(EXPORT_CHUNK_BYTES+17,42),downloads=new ExportDownloads(),lease=downloads.issue('g','d','j',meta(data,format))!;
  const chunks:Buffer[]=[],requests:number[]=[];
  for await(const chunk of downloads.stream(lease.token,async(info,offset,limit)=>{
   requests.push(limit);assert.equal(info.groupId,'g');assert.equal(info.jobId,'j');
   return {result:{...meta(data,format),offset,nextOffset:offset+limit<data.length?offset+limit:null,body:data.subarray(offset,offset+limit).toString('base64')}};
  }))chunks.push(chunk);
  assert.deepEqual(requests,[EXPORT_CHUNK_BYTES,17]);assert.ok(Buffer.concat(chunks).equals(data));
 }
});

test('a changed file or corrupt payload never delivers its final chunk',async()=>{
 const data=Buffer.from('%PDF safe content'),downloads=new ExportDownloads(),lease=downloads.issue('g','d','j',meta(data))!;
 for(const patch of [{filename:'different.pdf'},{nextOffset:1},{body:'not base64'},{body:Buffer.alloc(data.length,0).toString('base64')}]){
  const delivered:Buffer[]=[];
  await assert.rejects(async()=>{for await(const chunk of downloads.stream(lease.token,async()=>({result:{...meta(data),offset:0,nextOffset:null,body:data.toString('base64'),...patch}})))delivered.push(chunk);},/invalid|changed|checksum/i);
  assert.equal(delivered.length,0);
 }
});

test('cancelled downloads release capacity; expired or unknown tokens never read a device',async()=>{
 const data=Buffer.from('small'),downloads=new ExportDownloads(),lease=downloads.issue('g','d','j',meta(data,'md'))!;let calls=0;
 const fetch=async()=>{calls++;return {result:{...meta(data,'md'),offset:0,nextOffset:null,body:data.toString('base64')}};};
 await assert.rejects(async()=>{for await(const _ of downloads.stream(lease.token,fetch,()=>true)){}},/cancelled/);assert.equal(calls,0);
 await assert.rejects(async()=>{for await(const _ of downloads.stream('unknown',fetch)){}},/expired/);assert.equal(calls,0);
 for await(const _ of downloads.stream(lease.token,fetch)){}assert.equal(calls,1);
});

test('stalled, drained and disconnected clients release their backpressure listeners',async()=>{
 const {EventEmitter}=await import('node:events');const {waitForDownloadDrain,attachmentHeader}=await import('./downloads.js');
 const stalled=new EventEmitter();await assert.rejects(waitForDownloadDrain(stalled,5),/stopped reading/);assert.equal(stalled.eventNames().length,0);
 const drained=new EventEmitter(),ready=waitForDownloadDrain(drained);drained.emit('drain');await ready;assert.equal(drained.eventNames().length,0);
 const closed=new EventEmitter(),cancelled=waitForDownloadDrain(closed);closed.emit('close');await assert.rejects(cancelled,/cancelled/);assert.equal(closed.eventNames().length,0);
 assert.equal(attachmentHeader("Cat's (notes)*.md"),"attachment; filename*=UTF-8''Cat%27s%20%28notes%29%2A.md");
});
