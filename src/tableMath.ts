/** GFM tokenizes pipes before inline math. Protect only complete math spans in
 * actual tables, never currency, code fences or ordinary prose. Insertions keep
 * every original source offset available to the editor's parser wrapper. */
export function tableMathPipeInsertions(source:string):Array<{at:number;text:string}> {
  const rows=source.split("\n"), offsets:number[]=[];let offset=0,fence="";
  const tableRows=new Set<number>();
  for(let i=0;i<rows.length;i++){
    offsets.push(offset);offset+=rows[i].length+1;
    const mark=rows[i].trimStart().match(/^(`{3,}|~{3,})/);
    if(mark){if(!fence)fence=mark[1];else if(mark[1][0]===fence[0]&&mark[1].length>=fence.length)fence="";continue;}
    if(fence)continue;
    if(i>0&&/^\s*(?:>\s*)*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(rows[i])&&rows[i-1].includes("|")){
      tableRows.add(i-1);
      for(let j=i+1;j<rows.length&&rows[j].trim()&&rows[j].includes("|");j++)tableRows.add(j);
    }
  }
  const result:Array<{at:number;text:string}>=[];
  for(const row of tableRows){
    const text=rows[row];let code=0;
    const escaped=(i:number)=>{let count=0;while(i>0&&text[--i]==="\\")count++;return count%2===1;};
    for(let i=0;i<text.length;i++){
      if(text[i]==="`"&&!escaped(i)){let n=1;while(text[i+n]==="`")n++;if(!code)code=n;else if(code===n)code=0;i+=n-1;continue;}
      if(code||text[i]!=="$"||escaped(i))continue;
      const length=text[i+1]==="$"?2:1,from=i+length;let end=from;
      while(end<text.length){if(text[end]==="$"&&!escaped(end)&&(length===1?text[end+1]!=="$":text[end+1]==="$"))break;end++;}
      if(end===text.length)continue;
      const body=text.slice(from,end);
      if(/[\\^_]|\|/.test(body)&&!/^\s*\d+(?:[.,]\d+)?\s*$/.test(body)){
        for(let p=from;p<end;p++)if(text[p]==="|"&&!escaped(p))result.push({at:offsets[row]+p,text:"\\"});
      }
      i=end+length-1;
    }
  }
  return result.sort((a,b)=>a.at-b.at);
}
