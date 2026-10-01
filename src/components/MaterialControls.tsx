"use client";
import { createElement, memo, type ReactNode, type FormEvent } from "react";
import { M3Button } from "@banegasn/m3-button";
import { css } from "lit";
import { MdSlider } from "@material/web/slider/slider.js";
import { MdSwitch } from "@material/web/switch/switch.js";

// Document CSS cannot cross a component's shadow boundary. Keep Google's
// controls intact, but explicitly carry the app's motion preference inside.
const controlMotion = css`
  :host([motion-off]) *, :host([motion-off]) *::before, :host([motion-off]) *::after { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;
class StudySlider extends MdSlider { static styles = [...MdSlider.styles, controlMotion]; }
class StudySwitch extends MdSwitch { static styles = [...MdSwitch.styles, controlMotion]; }
if (!customElements.get("smd-slider")) customElements.define("smd-slider", StudySlider);
if (!customElements.get("smd-switch")) customElements.define("smd-switch", StudySwitch);

// MIT-licensed community Expressive buttons share Google's Material theme
// with official sliders/switches. Only font and motion-off integration extend
// the component; its own shape changes, focus and keyboard behavior remain.
class StudyButton extends M3Button {
  static styles = css`${M3Button.styles}
    button { font-family: var(--md-ref-typeface-plain, system-ui); }
    :host([motion-off]) button, :host([motion-off]) button::before { transition: none; }
    :host([motion-off]) button:active { transform: none; }
    @media (prefers-reduced-motion: reduce) { button, button::before { transition: none; } button:active { transform: none; } }
  `;
}
if (!customElements.get("smd-expressive-button")) customElements.define("smd-expressive-button", StudyButton);
export const MaterialButton = memo(function MaterialButton({ children, onClick, disabled, className, label, motion = true }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; label?: string; motion?: boolean }) {
  return createElement("smd-expressive-button", { onClick, disabled, className, fullWidth: className === "primary-action", variant: "filled", size: "small", padding: "small", "motion-off": motion ? undefined : "", "aria-label": label }, children);
});
export const MaterialSlider = memo(function MaterialSlider({ value, min, max, step = 1, label, onChange, motion = true }: { value: number; min: number; max: number; step?: number; label: string; onChange: (value: number) => void; motion?: boolean }) {
  return createElement("smd-slider", { value, min, max, step, "motion-off": motion ? undefined : "", "aria-label": label, onInput: (event: FormEvent<HTMLElement>) => onChange((event.currentTarget as HTMLElement & { value: number }).value) });
});
export const MaterialSwitch = memo(function MaterialSwitch({ checked, disabled, label, onChange, motion = true }: { checked: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void; motion?: boolean }) {
  return createElement("smd-switch", { selected: checked, disabled, "motion-off": motion ? undefined : "", "aria-label": label, onChange: (event: FormEvent<HTMLElement>) => onChange((event.currentTarget as HTMLElement & { selected: boolean }).selected) });
});
