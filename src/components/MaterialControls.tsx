"use client";
import { createElement, memo, type ReactNode, type FormEvent, type KeyboardEvent } from "react";
import { M3Button } from "@banegasn/m3-button";
import { M3IconButton } from "@banegasn/m3-icon-button";
import { css } from "lit";
import { MdSlider } from "@material/web/slider/slider.js";
import { MdSwitch } from "@material/web/switch/switch.js";
import { MdFilledSelect } from "@material/web/select/filled-select.js";
import "@material/web/select/select-option.js";

// Document CSS cannot cross a component's shadow boundary. Keep Google's
// controls intact, but explicitly carry the app's motion preference inside.
const controlMotion = css`
  :host([motion-off]) *, :host([motion-off]) *::before, :host([motion-off]) *::after { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;
class StudySlider extends MdSlider { static styles = [...MdSlider.styles, css`.handleNub { box-shadow: 0 0 0 6px var(--md-sys-color-surface-container-low); }`, controlMotion]; }
class StudySwitch extends MdSwitch { static styles = [...MdSwitch.styles, controlMotion]; }
class StudySelect extends MdFilledSelect { static styles = [...MdFilledSelect.styles, controlMotion]; }
class StudyIconButton extends M3IconButton {
  static styles = css`${M3IconButton.styles}
    .icon-button { transition: border-radius var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized), background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized), color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized); }
    :host([toggle]) .icon-button { transition: border-radius var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized), background-color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized), color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized); }
    :host([selected]) .icon-button, .icon-button:active { border-radius: 12px; }
    .icon-button:active { transform: none; }
    :host([motion-off]) .icon-button:active .icon { transform: none; }
    @media (prefers-reduced-motion: reduce) { .icon-button:active .icon { transform: none; } }
    ${controlMotion}
  `;
}
if (!customElements.get("smd-slider")) customElements.define("smd-slider", StudySlider);
if (!customElements.get("smd-switch")) customElements.define("smd-switch", StudySwitch);
if (!customElements.get("smd-select")) customElements.define("smd-select", StudySelect);
if (!customElements.get("smd-icon-button")) customElements.define("smd-icon-button", StudyIconButton);

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
export const MaterialButton = memo(function MaterialButton({ children, onClick, disabled, className, label, motion = true, variant = "filled" }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; label?: string; motion?: boolean; variant?: "filled" | "tonal" | "text" }) {
  return createElement("smd-expressive-button", { onClick, disabled, className, fullWidth: className === "primary-action", variant, size: "small", padding: "small", "motion-off": motion ? undefined : "", "aria-label": label }, children);
});
export const MaterialIconButton = memo(function MaterialIconButton({ children, onClick, label, title, selected, motion = true }: { children: ReactNode; onClick: () => void; label: string; title?: string; selected?: boolean; motion?: boolean }) {
  return createElement("smd-icon-button", { onClick, "aria-label": label, title, selected, toggle: selected !== undefined, variant: selected ? "tonal" : "standard", size: "medium", "motion-off": motion ? undefined : "" }, children);
});
export const MaterialSelect = memo(function MaterialSelect({ value, label, options, onChange, motion = true, disabled }: { value: string; label: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; motion?: boolean; disabled?: boolean }) {
  return createElement("smd-select", {
    value, label, disabled, quick: !motion, menuPositioning: typeof HTMLElement.prototype.showPopover === "function" ? "popover" : "fixed", "motion-off": motion ? undefined : "",
    onChange: (event: FormEvent<HTMLElement>) => onChange((event.currentTarget as HTMLElement & { value: string }).value),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (event.key === "Escape" && (event.currentTarget.shadowRoot?.querySelector("md-menu") as HTMLElement & { open?: boolean } | null)?.open) event.stopPropagation(); },
  }, options.map(option => createElement("md-select-option", { key: option.value, value: option.value, selected: value === option.value }, createElement("span", { slot: "headline" }, option.label))));
});
export const materialThemes = [{ value: "system", label: "System dynamic" }, { value: "light", label: "Material light" }, { value: "dark", label: "Material dark" }, { value: "black", label: "Pure black" }];
export const MaterialSlider = memo(function MaterialSlider({ value, min, max, step = 1, label, onChange, motion = true }: { value: number; min: number; max: number; step?: number; label: string; onChange: (value: number) => void; motion?: boolean }) {
  return createElement("smd-slider", { value, min, max, step, "motion-off": motion ? undefined : "", "aria-label": label, onInput: (event: FormEvent<HTMLElement>) => onChange((event.currentTarget as HTMLElement & { value: number }).value) });
});
export const MaterialSwitch = memo(function MaterialSwitch({ checked, disabled, label, onChange, motion = true }: { checked: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void; motion?: boolean }) {
  return createElement("smd-switch", { selected: checked, disabled, "motion-off": motion ? undefined : "", "aria-label": label, onChange: (event: FormEvent<HTMLElement>) => onChange((event.currentTarget as HTMLElement & { selected: boolean }).selected) });
});
