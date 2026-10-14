export type MediaAppearance='original'|'invert-dark'|'auto'|'contrast';
export function mediaFilter(mode:MediaAppearance|undefined,dark:boolean,contrast=1.25):string {
  const strength=Number.isFinite(contrast)?Math.max(1,Math.min(2,contrast)):1.25;
  if(mode==='invert-dark')return dark?'invert(1) hue-rotate(180deg)':'none';
  if(mode==='auto')return `${dark?'invert(.9) hue-rotate(180deg) ':''}sepia(.2) saturate(.8) contrast(${strength})`;
  if(mode==='contrast')return `contrast(${strength})`;
  return 'none';
}
