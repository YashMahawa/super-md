import {mediaTone} from '../mediaAppearance';

/** Fixed SVG primitives only; no authored markup, resources, source rewriting
 * or full-resolution image buffers. Updating three tables recolours all media. */
export default function MediaThemeFilters({colors,dark}:{colors:Record<string,string>;dark:boolean}) {
  const {channels}=mediaTone(colors,dark);
  return <svg width="0" height="0" aria-hidden="true" style={{position:'absolute',pointerEvents:'none'}}><defs>{[false,true].map(reverse=><filter key={String(reverse)} id={`supermd-media-tone${reverse?'-reverse':''}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
      <feColorMatrix type="matrix" values=".2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 0 0 0 1 0"/>
      <feComponentTransfer>{channels.map((values,i)=>{const props={type:'table' as const,tableValues:reverse?values.split(' ').reverse().join(' '):values};return i===0?<feFuncR key={i} {...props}/>:i===1?<feFuncG key={i} {...props}/>:<feFuncB key={i} {...props}/>;})}<feFuncA type="identity"/></feComponentTransfer>
    </filter>)}
    <filter id="supermd-media-adapt" colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
      <feColorMatrix in="SourceGraphic" type="saturate" values="0" result="gray"/>
      <feBlend in="SourceGraphic" in2="gray" mode="difference" result="chroma"/>
      <feColorMatrix in="chroma" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3 3 3 0 0" result="chroma-alpha"/>
      <feComponentTransfer in="chroma-alpha" result="neutrals"><feFuncA type="table" tableValues="1 0 0 0 0 0 0 0 0"/></feComponentTransfer>
      <feComponentTransfer in="gray" result="toned">{channels.map((values,i)=>{const props={type:'table' as const,tableValues:values};return i===0?<feFuncR key={i} {...props}/>:i===1?<feFuncG key={i} {...props}/>:<feFuncB key={i} {...props}/>;})}<feFuncA type="identity"/></feComponentTransfer>
      <feComposite in="toned" in2="neutrals" operator="in" result="neutral-pixels"/>
      <feComposite in="SourceGraphic" in2="neutrals" operator="out" result="colour-pixels"/>
      <feMerge><feMergeNode in="colour-pixels"/><feMergeNode in="neutral-pixels"/></feMerge>
    </filter>
    </defs></svg>;
}
