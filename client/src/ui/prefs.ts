/** UI-only preferences that are not part of the Settings contract: tips on/off and which tips were shown. */
const KEY = 'glimmergrave.ui.v1';

interface Prefs {
  tips: boolean;
  seen: string[];
}

function load(): Prefs {
  const fallback: Prefs = { tips: true, seen: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<Prefs>;
    return {
      tips: stored.tips !== false,
      seen: Array.isArray(stored.seen) ? stored.seen.filter((id): id is string => typeof id === 'string') : [],
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
