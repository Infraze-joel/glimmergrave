/** Tiny DOM helpers. User-provided strings always go through text nodes, never innerHTML. */
import { ICONS, type IconName } from './icons.ts';

type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined | ((ev: never) => void);
export type Attrs = Record<string, AttrValue>;

const EVENT_PREFIX = 'on';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs?: Attrs | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') {
        el.addEventListener(key.slice(EVENT_PREFIX.length).toLowerCase(), value as EventListener);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
}

/** replaceChildren that tolerates null / false children. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

/** Inline SVG icon (static, trusted markup from icons.ts). */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls ? `gg-icon ${cls}` : 'gg-icon';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name];
  return el;
}

export function key(label: string): HTMLElement {
  return h('kbd', { class: 'gg-key' }, label);
}

/** Writes textContent only when it changed (keeps 15 Hz HUD updates cheap). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

export function toggle(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

/** Restarts a CSS animation class. */
export function retrigger(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/**
 * Text fields must not leak key events to the game input module (typing a name must not move the hero).
 * Enter / Escape are handled here because the window-level UI key handler never sees them.
 */
export function guardTextField(input: HTMLInputElement, onEnter?: () => void, onEscape?: () => void): void {
  const stop = (ev: Event): void => ev.stopPropagation();
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && onEnter) { ev.preventDefault(); onEnter(); }
    if (ev.key === 'Escape') { ev.preventDefault(); input.blur(); onEscape?.(); }
  });
  input.addEventListener('keyup', stop);
  input.addEventListener('keypress', stop);
}

export function blurActive(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (insecure origin / denied): fall back to a hidden textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
