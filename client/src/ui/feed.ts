/**
 * Event feed of the HUD (top-right): short notices such as "Mirelle is down!" or "Brazier lit — 2/3 burn".
 *
 * Polish 1 — a four-hero fight used to scroll important lines away within a second. The rules now:
 *  - one line per topic (`key`): a repeat joins the line that is already there ("2 ultimates ready",
 *    "Mirelle and Bruno are down!") instead of adding another one;
 *  - at most FEED_MAX lines; when a new line needs room the least important line goes first, and a line that
 *    is less important than everything on screen is not shown at all;
 *  - lines live shorter while the feed is crowded, and low-priority lines always live short.
 */
import { settings } from '../core/Settings.ts';
import { h, icon, retrigger, setAttr, setText } from './dom.ts';
import type { IconName } from './icons.ts';
import { UI_CONFIG } from './store.ts';

/** Importance of a line. `LOW` lines (an ally's ultimate, an ally's boon) never push anything else out. */
export const FEED_PRIORITY = { LOW: 0, INFO: 1, NOTICE: 2, ALERT: 3 } as const;
export type FeedPriority = (typeof FEED_PRIORITY)[keyof typeof FEED_PRIORITY];

export interface FeedEntry {
  /** Topic of the line. A new entry with the key of a visible line updates that line. */
  key: string;
  icon: IconName;
  /** `data-tone` of the line (colours). */
  tone: string;
  priority: FeedPriority;
  /** Text of a line without items: a newer entry of the topic simply replaces it. */
  text?: string;
  /**
   * What this entry adds to its topic (a hero's name, an element). The distinct items of a live line are
   * collected and the line reads `list(items)` (called with one or more items).
   */
  item?: string;
  list?: (items: string[]) => string;
}

export interface FeedView {
  el: HTMLElement;
  push(entry: FeedEntry): void;
  /** Takes one item out of a topic's line (a downed hero was revived); the line goes when it was the last. */
  dropItem(key: string, item: string): void;
  reset(): void;
  dispose(): void;
}

interface Line {
  entry: FeedEntry;
  items: string[];
  el: HTMLElement;
  label: HTMLElement;
  /** performance.now() at which the line leaves. */
  until: number;
  /** Order of the last update: among equally important lines the stalest goes first. */
  touched: number;
}

export function createFeed(): FeedView {
  const el = h('ul', { class: 'gg-feed', 'aria-live': 'polite', 'data-testid': 'hud-feed', 'data-lines': '0' });
  const lines: Line[] = [];
  let timer = 0;
  let clock = 0;

  const textOf = (line: Line): string =>
    (line.items.length > 0 && line.entry.list ? line.entry.list(line.items) : line.entry.text ?? '');

  const paint = (line: Line): void => {
    setText(line.label, textOf(line));
    setAttr(line.el, 'data-tone', line.entry.tone);
    setAttr(line.el, 'data-count', String(Math.max(1, line.items.length)));
  };

  const remove = (line: Line, fade: boolean): void => {
    const index = lines.indexOf(line);
    if (index < 0) return;
    lines.splice(index, 1);
    setAttr(el, 'data-lines', String(lines.length));
    if (!fade) { line.el.remove(); return; }
    line.el.classList.add('is-leaving');
    window.setTimeout(() => line.el.remove(), UI_CONFIG.FEED_FADE_MS);
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (lines.length === 0) return;
    const next = Math.min(...lines.map((line) => line.until));
    timer = window.setTimeout(expire, Math.max(0, next - performance.now()) + 1);
  };

  function expire(): void {
    const now = performance.now();
    for (const line of [...lines]) if (line.until <= now) remove(line, true);
    schedule();
  }

  /** How long a line pushed now stays: short for low-priority lines and while the feed is crowded. */
  const lifetime = (priority: FeedPriority): number => {
    if (priority <= FEED_PRIORITY.LOW) return UI_CONFIG.FEED_LOW_MS;
    return lines.length >= UI_CONFIG.FEED_BUSY_LINES ? UI_CONFIG.FEED_BUSY_MS : UI_CONFIG.FEED_MS;
  };

  const push = (entry: FeedEntry): void => {
    const now = performance.now();
    clock += 1;
    const live = lines.find((line) => line.entry.key === entry.key);
    if (live) {
      if (entry.item !== undefined && !live.items.includes(entry.item)) live.items.push(entry.item);
      else if (entry.item === undefined) live.items.length = 0;
      live.entry = entry;
      live.until = now + lifetime(entry.priority);
      live.touched = clock;
      paint(live);
      retrigger(live.el, 'is-bump');
      schedule();
      return;
    }
    // The "minimal" effects setting also thins the feed out.
    const max = settings.effects === 'minimal' ? UI_CONFIG.FEED_MAX_MINIMAL : UI_CONFIG.FEED_MAX;
    while (lines.length > max) remove(lines[0], false);
    if (lines.length >= max) {
      // Room is made by the least important line (the stalest among equals) — unless the newcomer is it.
      const weakest = lines.reduce((a, b) => (b.entry.priority < a.entry.priority || (b.entry.priority === a.entry.priority && b.touched < a.touched) ? b : a));
      if (weakest.entry.priority > entry.priority) return;
      remove(weakest, false);
    }
    const label = h('span');
    const item = h('li', { class: 'gg-feed-item', 'data-key': entry.key, 'data-priority': String(entry.priority) }, icon(entry.icon), label);
    const line: Line = { entry, items: entry.item !== undefined ? [entry.item] : [], el: item, label, until: 0, touched: clock };
    line.until = now + lifetime(entry.priority);
    lines.push(line);
    paint(line);
    el.append(item);
    setAttr(el, 'data-lines', String(lines.length));
    // A crowded feed clears faster: nothing that is already there outlives the busy lifetime.
    if (lines.length >= UI_CONFIG.FEED_BUSY_LINES) {
      for (const other of lines) other.until = Math.min(other.until, now + UI_CONFIG.FEED_BUSY_MS);
    }
    schedule();
  };

  const dropItem = (key: string, item: string): void => {
    const line = lines.find((candidate) => candidate.entry.key === key);
    if (!line) return;
    const index = line.items.indexOf(item);
    if (index < 0) return;
    line.items.splice(index, 1);
    if (line.items.length === 0) { remove(line, true); schedule(); return; }
    paint(line);
  };

  const reset = (): void => {
    window.clearTimeout(timer);
    lines.length = 0;
    el.replaceChildren();
    setAttr(el, 'data-lines', '0');
  };

  return { el, push, dropItem, reset, dispose: () => window.clearTimeout(timer) };
}
