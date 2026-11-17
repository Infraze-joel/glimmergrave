/**
 * Inline markup for i18n strings, rendered as DOM nodes (never innerHTML):
 *   [[ember|text]] [[rime|text]] [[storm|text]] [[res|text]]   element-coloured keywords
 *   [[b|text]] bold     [[key|W]] key cap     [[lmb]] [[rmb]] mouse buttons
 */
import { h, icon, key } from './dom.ts';

const MARKUP = /\[\[(\w+)(?:\|([^\]]*))?\]\]/g;
const TONES = new Set(['ember', 'rime', 'storm', 'res']);

function node(tag: string, content: string): Node {
  if (TONES.has(tag)) return h('span', { class: `gg-kw gg-kw--${tag}` }, content);
  if (tag === 'b') return h('strong', { class: 'gg-kw-b' }, content);
  if (tag === 'key') return key(content);
  if (tag === 'lmb') return icon('mouseLeft', 'gg-kw-mouse');
  if (tag === 'rmb') return icon('mouseRight', 'gg-kw-mouse');
  return document.createTextNode(content);
}

/** Parses the markup into text nodes, keyword spans, key caps and mouse icons. */
export function rich(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKUP)) {
    const at = match.index;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    out.push(node(match[1], match[2] ?? ''));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** The same string without markup, for titles, aria labels and change detection. */
export function plain(text: string): string {
  return text.replace(MARKUP, (_m, tag: string, content?: string) => content ?? (tag === 'lmb' ? 'LMB' : tag === 'rmb' ? 'RMB' : ''));
}

/** <tag class>…rich content…</tag> */
export function richEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text: string): HTMLElementTagNameMap[K] {
  const el = h(tag, { class: cls });
  el.append(...rich(text));
  return el;
}

/** Wraps a value in keyword markup so it can be passed as a parameter into a rich string. */
export function mark(tone: 'ember' | 'rime' | 'storm' | 'res' | 'b', text: string): string {
  return `[[${tone}|${text}]]`;
}
