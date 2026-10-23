import {flushSync} from 'react-dom';
import {captureScrollAnchor} from './scrollAnchor';

/** Commit an asynchronous media size change before the next paint, keeping
 * the visible source location fixed. Never poll or observe the whole document.
 * Call from load/promise callbacks, not during React rendering or effects. */
export function commitMediaLayout(element:HTMLElement|null,update:()=>void):void {
  const root=element?.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane');
  const block=element?.closest<HTMLElement>('[data-windowed-block]');
  const restore=root?captureScrollAnchor(root):undefined;
  flushSync(update);
  // Release a remounted block's cached footprint in this same transaction,
  // after all of its media are ready (including decoding failures).
  block?.dispatchEvent(new Event('supermd-media-layout'));
  restore?.();
}
