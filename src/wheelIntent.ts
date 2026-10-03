/** DOM wheel events have no reliable device ID. Coarse notches scroll; fine
 * pixel deltas pan canvases. Ctrl/Meta (including trackpad pinch) magnifies. */
export function wheelIntent(event: Pick<WheelEvent,"ctrlKey"|"metaKey"|"deltaMode"|"deltaX"|"deltaY"|"buttons">, held=false): "zoom"|"pan"|"scroll" {
  if(event.ctrlKey || event.metaKey || held || (event.buttons&1))return "zoom";
  if(event.deltaMode!==0)return "scroll";
  const y=Math.abs(event.deltaY);
  return event.deltaX!==0 || y>0 && y<80 && y%40!==0 ? "pan" : "scroll";
}
