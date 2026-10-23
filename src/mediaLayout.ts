import {flushSync} from 'react-dom';
import {captureScrollAnchor} from './scrollAnchor';

/** Commit an asynchronous media size change before the next paint, keeping
 * the visible source location fixed. Never poll or observe the whole document.
 * Call from load/promise callbacks, not during React rendering or effects. */
export function commitMediaLayout(element:HTMLElement|null,update:()=>void):void {
  const root=element?.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane');
  const restore=root?captureScrollAnchor(root):undefined;
  flushSync(update);
  restore?.();
}
