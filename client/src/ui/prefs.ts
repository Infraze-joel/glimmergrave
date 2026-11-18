/** UI-only preferences that are not part of the Settings contract: tips on/off and which tips were shown. */
const KEY = 'glimmergrave.ui.v1';

interface Prefs {
  tips: boolean;
  seen: string[];
  /** Things the player has looked at once (e.g. `art.knight`: the art choice of a class), so badges can go away. */
  marks: string[];
}

function load(): Prefs {
  const fallback: Prefs = { tips: true, seen: [], marks: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<Prefs>;
    return {
      tips: stored.tips !== false,
      seen: Array.isArray(stored.seen) ? stored.seen.filter((id): id is string => typeof id === 'string') : [],
      marks: Array.isArray(stored.marks) ? stored.marks.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return fallback; // storage unavailable or corrupt
  }
}

const prefs = load();

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

export function tipsEnabled(): boolean {
  return prefs.tips;
}

export function setTipsEnabled(on: boolean): void {
  prefs.tips = on;
  save();
}

export function tipSeen(id: string): boolean {
  return prefs.seen.includes(id);
}

export function markTipSeen(id: string): void {
  if (prefs.seen.includes(id)) return;
  prefs.seen.push(id);
  save();
}

export function resetTips(): void {
  prefs.seen = [];
  save();
}

export function isMarked(id: string): boolean {
  return prefs.marks.includes(id);
}

export function setMark(id: string): void {
  if (prefs.marks.includes(id)) return;
  prefs.marks.push(id);
  save();
}

export function resetMarks(): void {
  prefs.marks = [];
  save();
}
