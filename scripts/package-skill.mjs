import {readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(root,'docs/skills/super-md');
const destination=path.join(root,'dist');mkdirSync(destination,{recursive:true});
cpSync(source,path.join(destination,'super-md-skill'),{recursive:true});
const entries=[];
function walk(dir,prefix='super-md'){
 for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.name==='local-preferences.md'||entry.name.startsWith('.'))continue;
  const name=prefix+'/'+entry.name,absolute=path.join(dir,entry.name);
  if(entry.isDirectory())walk(absolute,name);
  else if(entry.isFile())entries.push({name,body:readFileSync(absolute)});
 }
}
walk(source);
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
let offset=0;const blocks=[],central=[];
for(const {name,body} of entries){
 const filename=Buffer.from(name),crc=crc32(body),local=Buffer.alloc(30);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);
 local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(filename.length,26);
 blocks.push(local,filename,body);
 const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(33,14);
 record.writeUInt32LE(crc,16);record.writeUInt32LE(body.length,20);record.writeUInt32LE(body.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42);
 central.push(record,filename);offset+=local.length+filename.length+body.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
writeFileSync(path.join(destination,'super-md-skill.zip'),Buffer.concat([...blocks,directory,end]));
