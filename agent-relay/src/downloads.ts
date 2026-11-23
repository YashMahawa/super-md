import { createHash, randomBytes } from 'node:crypto';

export type Download = { token:string; groupId:string; deviceId:string; jobId:string; filename:string; format:'md'|'smd'|'pdf'; mimeType:string; bytes:number; sha256:string; expiresAt:number };
type Reply={result?:unknown;error?:string};
const MIMES={md:'text/markdown',smd:'application/vnd.supermd.smd',pdf:'application/pdf'} as const;
export const EXPORT_CHUNK_BYTES=512*1024;
export const MAX_DOWNLOAD_BYTES=128*1024*1024;
export function attachmentHeader(filename:string):string {
  return "attachment; filename*=UTF-8''"+encodeURIComponent(filename).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
}
export function waitForDownloadDrain(stream:{once:(event:string,callback:()=>void)=>unknown;off:(event:string,callback:()=>void)=>unknown},timeoutMs=15_000):Promise<void>{
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);stream.off('drain',drained);stream.off('close',closed);};
    const drained=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(Error('Download cancelled'));};
    const timer=setTimeout(()=>{cleanup();reject(Error('Download client stopped reading'));},timeoutMs);
    stream.once('drain',drained);stream.once('close',closed);
  });
}
/** Small capability records only. Document bytes are streamed, never retained. */
export class ExportDownloads {
  private leases=new Map<string,Download>();
  private active=new Set<string>();
  constructor(private now:()=>number=Date.now,private ttl=10*60_000,private capacity=128){}
  issue(groupId:string,deviceId:string,jobId:string,value:unknown):Download|null {
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const meta=value as Record<string,unknown>;
    if(meta.downloadable!==true||(meta.status!=='completed'&&meta.phase!=='completed')||typeof meta.filename!=='string'||!meta.filename||meta.filename.length>256||/[\\/\x00-\x1f\x7f]/.test(meta.filename)||!['md','smd','pdf'].includes(String(meta.format))||!Number.isSafeInteger(meta.bytes)||Number(meta.bytes)<0||Number(meta.bytes)>MAX_DOWNLOAD_BYTES||typeof meta.sha256!=='string'||!/^[a-f0-9]{64}$/.test(meta.sha256))return null;
    for(const [token,lease] of this.leases)if(lease.expiresAt<=this.now()&&!this.active.has(token))this.leases.delete(token);
    for(const lease of this.leases.values())if(lease.groupId===groupId&&lease.deviceId===deviceId&&lease.jobId===jobId&&lease.sha256===meta.sha256)return lease;
    if(this.leases.size>=this.capacity)return null;
    const format=meta.format as Download['format'];
    const lease:Download={token:randomBytes(24).toString('base64url'),groupId,deviceId,jobId,filename:meta.filename,format,mimeType:MIMES[format],bytes:Number(meta.bytes),sha256:meta.sha256,expiresAt:this.now()+this.ttl};
    this.leases.set(lease.token,lease);return lease;
  }
  get(token:string):Download|undefined {const lease=this.leases.get(token);return lease&&lease.expiresAt>this.now()?lease:undefined;}
  async *stream(token:string,fetchChunk:(lease:Download,offset:number,limit:number)=>Promise<Reply>,aborted:()=>boolean=()=>false):AsyncGenerator<Buffer> {
    const lease=this.get(token);if(!lease)throw Error('The export download link expired; check the job again.');
    if(this.active.has(token)||this.active.size>=4)throw Error('Export download capacity reached; retry shortly.');
    this.active.add(token);
    const digest=createHash('sha256');let offset=0;
    try {
      while(offset<lease.bytes){
        if(aborted())throw Error('Export download cancelled.');
        if(lease.expiresAt<=this.now())throw Error('Export download expired.');
        const limit=Math.min(EXPORT_CHUNK_BYTES,lease.bytes-offset),reply=await fetchChunk(lease,offset,limit);
        if(reply.error)throw Error('The device could not read this completed export.');
        const item=reply.result as Record<string,unknown>|undefined;
        if(!item||item.offset!==offset||item.bytes!==lease.bytes||item.sha256!==lease.sha256||item.filename!==lease.filename||item.format!==lease.format||typeof item.body!=='string'||item.body.length>4*Math.ceil(limit/3))throw Error('The completed export changed or returned an invalid chunk.');
        const data=Buffer.from(item.body,'base64');
        if(data.length!==limit||data.toString('base64')!==item.body)throw Error('The device returned an invalid export chunk.');
        offset+=data.length;
        if(item.nextOffset!==(offset<lease.bytes?offset:null))throw Error('The device returned an invalid export cursor.');
        digest.update(data);
        // Hold the last chunk until the whole checksum agrees. A failed stream
        // therefore cannot appear complete to an HTTP Content-Length client.
        if(offset===lease.bytes&&digest.digest('hex')!==lease.sha256)throw Error('Export checksum verification failed.');
        yield data;
      }
      if(lease.bytes===0&&digest.digest('hex')!==lease.sha256)throw Error('Export checksum verification failed.');
    } finally {this.active.delete(token);}
  }
}
