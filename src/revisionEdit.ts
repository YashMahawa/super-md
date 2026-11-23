import type {SourceChange} from './readerEdits';

export interface SourceRange {
  from:number;
  to:number;
}

export interface AlignedRevisionEdit {
  content:string;
  change:SourceChange;
}

/**
 * Align a `[from, to]` UTF-16 offset range from a rendered `baseSource`
 * revision onto the authoritative `currentSource` revision.
 *
 * Returns `null` if `[from, to]` is invalid or overlaps text that was modified
 * between `baseSource` and `currentSource`, preventing stale preview offsets
 * from ever overwriting newer user edits.
 */
export function alignRangeToCurrentSource(
  baseSource:string,
  currentSource:string,
  from:number,
  to:number,
):SourceRange|null {
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>to||to>baseSource.length)return null;
  if(baseSource===currentSource)return {from,to};

  const minLength=Math.min(baseSource.length,currentSource.length);
  let prefix=0;
  while(prefix<minLength&&baseSource.charCodeAt(prefix)===currentSource.charCodeAt(prefix))prefix++;

  const maxSuffix=minLength-prefix;
  let suffix=0;
  while(
    suffix<maxSuffix&&
    baseSource.charCodeAt(baseSource.length-1-suffix)===currentSource.charCodeAt(currentSource.length-1-suffix)
  ){
    suffix++;
  }

  const baseChangedEnd=baseSource.length-suffix;
  let mapped:SourceRange|null=null;

  if(from===to){
    // Point insertions at the exact start of the changed span stay before it;
    // point insertions at or after the end of the changed span shift with suffix.
    if(to<=prefix)mapped={from,to};
    else if(from>=baseChangedEnd){
      const delta=currentSource.length-baseSource.length;
      mapped={from:from+delta,to:to+delta};
    }
  }else if(to<=prefix){
    mapped={from,to};
  }else if(from>=baseChangedEnd){
    const delta=currentSource.length-baseSource.length;
    mapped={from:from+delta,to:to+delta};
  }

  if(!mapped)return null;
  if(mapped.from<0||mapped.to>currentSource.length||mapped.from>mapped.to)return null;
  if(currentSource.slice(mapped.from,mapped.to)!==baseSource.slice(from,to))return null;
  return mapped;
}

/** Apply an edit anchored to `baseSource` onto `currentSource` if non-overlapping. */
export function applyAlignedEdit(
  baseSource:string,
  currentSource:string,
  from:number,
  to:number,
  insert:string,
):AlignedRevisionEdit|null {
  const aligned=alignRangeToCurrentSource(baseSource,currentSource,from,to);
  if(!aligned)return null;
  return {
    content:currentSource.slice(0,aligned.from)+insert+currentSource.slice(aligned.to),
    change:{from:aligned.from,to:aligned.to,insert},
  };
}

/**
 * Align and apply a GFM task checkbox toggle (`[ ]` <-> `[x]`) from a rendered
 * `baseSource` revision onto `currentSource`, verifying bracket markers intact.
 */
export function applyAlignedTaskToggle(
  baseSource:string,
  currentSource:string,
  taskOffset:number,
  checked:boolean,
):AlignedRevisionEdit|null {
  if(!Number.isInteger(taskOffset)||taskOffset<1||taskOffset+1>=baseSource.length)return null;
  // Align the full 3-char `[ ]` / `[x]` / `[X]` token so surrounding brackets
  // are verified uncorrupted in `currentSource`.
  const bracketRange=alignRangeToCurrentSource(baseSource,currentSource,taskOffset-1,taskOffset+2);
  if(!bracketRange)return null;
  const mappedOffset=bracketRange.from+1;
  if(
    currentSource[mappedOffset-1]!=='['||
    currentSource[mappedOffset+1]!==']'||
    !/^[ xX]$/.test(currentSource[mappedOffset]??'')
  ){
    return null;
  }
  const insert=checked?'x':' ';
  return {
    content:currentSource.slice(0,mappedOffset)+insert+currentSource.slice(mappedOffset+1),
    change:{from:mappedOffset,to:mappedOffset+1,insert},
  };
}
