import nspell from "nspell";
import aff from "../node_modules/dictionary-en/index.aff?raw";
import dic from "../node_modules/dictionary-en/index.dic?raw";
import {writingIssues,type WritingOptions} from "./proofreadingCore";
let dictionary:ReturnType<typeof nspell>|undefined;
self.onmessage=(event:MessageEvent<{id:number;text:string;options:WritingOptions;blocked:Array<[number,number]>}>)=>{
  const {id,text,options,blocked}=event.data;
  try{
    if(options.spellCheck&&!dictionary)dictionary=nspell(aff,dic);
    self.postMessage({id,issues:writingIssues(text,options,dictionary,blocked)});
  }catch(error){self.postMessage({id,issues:[],error:String(error)});}
};
