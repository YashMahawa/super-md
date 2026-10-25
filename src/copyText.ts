import {invoke} from './nativeBridge';

/** Called only by explicit copy buttons. Offline native WebViews may lack the
 * browser Clipboard API; the host writes text, never reads the clipboard. */
export async function copyText(text:string):Promise<void> {
  // Native hosts own clipboard permission. Asking Chromium first can wait
  // indefinitely for a permission prompt that an offline WebView cannot show.
  if(window.SuperMD){await invoke('copy_text',{text});return;}
  if(!navigator.clipboard)throw new Error('Clipboard API unavailable');
  await navigator.clipboard.writeText(text);
}
