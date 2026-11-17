/**
 * Inline markup for i18n strings, rendered as DOM nodes (never innerHTML):
 *   [[ember|text]] [[rime|text]] [[storm|text]] [[res|text]]   element-coloured keywords
 *   [[b|text]] bold     [[key|W]] key cap     [[lmb]] [[rmb]] mouse buttons
 */
import { h, icon, key } from './dom.ts';
import { t } from './i18n.ts';

const MARKUP = /\[\[(\w+)(?:\|([^\]]*))?\]\]/g;
const TONES = new Set(['ember', 'rime', 'storm', 'res']);

function node(tag: string, content: string): Node {
  if (TONES.has(tag)) return h('span', { class: `gg-kw gg-kw--${tag}` }, content);
  if (tag === 'b') return h('strong', { class: 'gg-kw-b' }, content);
  if (tag === 'key') return key(content);
  // Mouse buttons carry the same label as the key caps under the ability bar.
  if (tag === 'lmb') return h('kbd', { class: 'gg-key gg-key--mouse' }, icon('mouseLeft'), t('hud.key.primary'));
  if (tag === 'rmb') return h('kbd', { class: 'gg-key gg-key--mouse' }, icon('mouseRight'), t('hud.key.secondary'));
  return document.createTextNode(content);
}

const LEADING_PUNCTUATION = /^[.,;:!?)]+/;

/**
 * A key cap must not be separated from the punctuation around it by a line break ("(" / ")" / "." alone on
 * a line): such neighbours are pulled into one non-breaking span with the key.
 */
function glue(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (!(current instanceof HTMLElement) || current.tagName !== 'KBD') { out.push(current); continue; }
    const group = h('span', { class: 'gg-kw-glue' });
    const before = out[out.length - 1];
    if (before instanceof Text && before.data.endsWith('(')) {
      before.data = before.data.slice(0, -1);
      group.append('(');
    }
    group.append(current);
    const after = nodes[i + 1];
    const tail = after instanceof Text ? LEADING_PUNCTUATION.exec(after.data) : null;
    if (after instanceof Text && tail) {
      group.append(tail[0]);
      after.data = after.data.slice(tail[0].length);
    }
    out.push(group.childNodes.length > 1 ? group : current);
  }
  return out;
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
  return glue(out);
}

/** The same string without markup, for titles, aria labels and change detection. */
export function plain(text: string): string {
  return text.replace(MARKUP, (_m, tag: string, content?: string) =>
    content ?? (tag === 'lmb' ? t('hud.key.primary') : tag === 'rmb' ? t('hud.key.secondary') : ''));
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
