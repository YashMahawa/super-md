import {mediaContrast,mediaTone} from '../mediaAppearance';

/** Fixed SVG primitives only; no authored markup, resources, source rewriting
 * or full-resolution image buffers. Updating three tables recolours all media. */
export default function MediaThemeFilters({colors,dark}:{colors:Record<string,string>;dark:boolean}) {
  const {channels,paper}=mediaTone(colors,dark);
  // On dark paper, reverse luminance before separating neutrals. This is the
  // single-matrix equivalent of invert(1) hue-rotate(180deg): every RGB channel
  // gets the same luminance offset, preserving hue while lifting dark colours.
  // White-matted antialiasing then becomes a dark edge, not an invented halo.
  // A many-surface per-pixel matte-removal graph made large-image zoom slower.
  const reverse=mediaContrast('#ffffff',paper)>mediaContrast('#000000',paper);
  return <svg width="0" height="0" aria-hidden="true" style={{position:'absolute',pointerEvents:'none'}}><defs>{[false,true].map(reverse=><filter key={String(reverse)} id={`supermd-media-tone${reverse?'-reverse':''}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
      <feColorMatrix type="matrix" values=".2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 0 0 0 1 0"/>
      <feComponentTransfer>{channels.map((values,i)=>{const props={type:'table' as const,tableValues:reverse?values.split(' ').reverse().join(' '):values};return i===0?<feFuncR key={i} {...props}/>:i===1?<feFuncG key={i} {...props}/>:<feFuncB key={i} {...props}/>;})}<feFuncA type="identity"/></feComponentTransfer>
    </filter>)}
    <filter id="supermd-media-adapt" colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
      {/* Work on straight colours, then restore SourceGraphic alpha once.
          Otherwise repeated composites darken transparent PNG edges. */}
      <feColorMatrix in="SourceGraphic" type="matrix" values={reverse?'.574 -1.43 -.144 0 1 -.426 -.43 -.144 0 1 -.426 -1.43 .856 0 1 0 0 0 0 1':'1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1'} result="opaque-source"/>
      <feColorMatrix in="opaque-source" type="saturate" values="0" result="gray"/>
      <feBlend in="opaque-source" in2="gray" mode="difference" result="chroma"/>
      <feColorMatrix in="chroma" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3 3 3 0 0" result="chroma-alpha"/>
      <feComponentTransfer in="chroma-alpha" result="neutrals"><feFuncA type="table" tableValues="1 0 0 0 0 0 0 0 0"/></feComponentTransfer>
      <feComponentTransfer in="gray" result="toned">{channels.map((values,i)=>{const props={type:'table' as const,tableValues:reverse?values.split(' ').reverse().join(' '):values};return i===0?<feFuncR key={i} {...props}/>:i===1?<feFuncG key={i} {...props}/>:<feFuncB key={i} {...props}/>;})}<feFuncA type="identity"/></feComponentTransfer>
      <feComposite in="toned" in2="neutrals" operator="in" result="neutral-pixels"/>
      {/* Tone over an opaque colour base, not two partially masked branches.
          This interpolates without alpha seams or an arithmetic compositor. */}
      <feMerge result="adapted"><feMergeNode in="opaque-source"/><feMergeNode in="neutral-pixels"/></feMerge>
      <feComposite in="adapted" in2="SourceGraphic" operator="in"/>
    </filter>
    </defs></svg>;
}
