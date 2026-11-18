/** User settings, persisted in localStorage. Read via `settings`, change via `updateSettings`. */
import { bus } from './EventBus.ts';

export type Quality = 'low' | 'medium' | 'high';
export type Lang = 'en' | 'de';
/** Mouse cursor over the 3D view while aiming: the game's reticle in two sizes, or the system pointer. */
export type CursorStyle = 'normal' | 'large' | 'system';
export const CURSOR_STYLES: readonly CursorStyle[] = ['normal', 'large', 'system'];
/**
 * How much of the friendly spectacle is drawn. Hostile telegraphs, enemies and the own hero's hits are never
 * reduced. `clear` (default): allies' effects as thin outlines, capped glow, few particles. `full`: everything.
 * `minimal`: allies' effects as outlines only, no ambient particles, smallest numbers.
 */
export type EffectsLevel = 'full' | 'clear' | 'minimal';
export const EFFECTS_LEVELS: readonly EffectsLevel[] = ['clear', 'full', 'minimal'];

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  quality: Quality;
  /** Screen shake intensity 0..1. */
  shake: number;
  /** Camera distance multiplier 0.8..1.3. */
  zoom: number;
  damageNumbers: boolean;
  cursor: CursorStyle;
  effects: EffectsLevel;
  /** Show damage numbers of other heroes' hits (the own hero's are governed by `damageNumbers`). */
  allyNumbers: boolean;
  lang: Lang;
}

const KEY = 'glimmergrave.settings.v1';

const defaults: Settings = {
  master: 0.8, music: 0.6, sfx: 0.9, quality: 'high', shake: 1, zoom: 1, damageNumbers: true, cursor: 'normal', effects: 'clear', allyNumbers: false,
  lang: typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch { /* storage unavailable: fall back to defaults */ }
  return { ...defaults };
}

export const settings: Settings = load();

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  bus.emit('settings:changed', settings);
}
