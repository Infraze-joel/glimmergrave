/**
 * Aim cursor for the 3D view. The system arrow disappears among enemies and effects, so while the player is
 * aiming the canvas shows a large, high-contrast reticle instead: a bright ring and centre dot with a dark
 * outline (readable on bright and dark ground alike) and gold ticks in the game's accent colour.
 * It is a native CSS cursor (an inline SVG), so it follows the mouse without any frame delay.
 */
import type { CursorStyle } from '../core/Settings.ts';

/** Edge length in CSS pixels per style. Browsers ignore cursor images above 128 px. */
const SIZE: Record<Exclude<CursorStyle, 'system'>, number> = { normal: 40, large: 64 };
const COLOR = { light: '#ffffff', dark: '#0b0d14', accent: '#ffcf5a' } as const;
/** Geometry in a 64-unit box. */
const VIEW = 64;
const CENTER = VIEW / 2;
const RING_RADIUS = 15;
const DOT_RADIUS = 3;
const TICK_INNER = 21;
const TICK_OUTER = 29;
const STROKE = { outline: 8, ring: 4, tickOutline: 8, tick: 4 } as const;
const FALLBACK = 'crosshair';

function reticleSvg(size: number): string {
  const c = CENTER;
  const ticks = [[0, -1], [1, 0], [0, 1], [-1, 0]]
    .map(([dx, dy]) => `M${c + dx * TICK_INNER} ${c + dy * TICK_INNER}L${c + dx * TICK_OUTER} ${c + dy * TICK_OUTER}`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}" fill="none" stroke-linecap="round">`
    + `<circle cx="${c}" cy="${c}" r="${RING_RADIUS}" stroke="${COLOR.dark}" stroke-width="${STROKE.outline}"/>`
    + `<path d="${ticks}" stroke="${COLOR.dark}" stroke-width="${STROKE.tickOutline}"/>`
    + `<circle cx="${c}" cy="${c}" r="${RING_RADIUS}" stroke="${COLOR.light}" stroke-width="${STROKE.ring}"/>`
    + `<path d="${ticks}" stroke="${COLOR.accent}" stroke-width="${STROKE.tick}"/>`
    + `<circle cx="${c}" cy="${c}" r="${DOT_RADIUS + 2}" fill="${COLOR.dark}"/>`
    + `<circle cx="${c}" cy="${c}" r="${DOT_RADIUS}" fill="${COLOR.light}"/>`
    + '</svg>';
}

/** CSS `cursor` value for a style; the hotspot is the centre of the reticle. */
export function cursorCss(style: CursorStyle): string {
  if (style === 'system') return 'default';
  const size = SIZE[style];
  const hot = Math.round(size / 2);
  return `url("data:image/svg+xml,${encodeURIComponent(reticleSvg(size))}") ${hot} ${hot}, ${FALLBACK}`;
}

/** Shows the reticle on `canvas` while `aiming` is true, the normal pointer otherwise. */
export function applyCursor(canvas: HTMLCanvasElement, style: CursorStyle, aiming: boolean): void {
  const value = aiming ? cursorCss(style) : '';
  if (canvas.style.cursor !== value) canvas.style.cursor = value;
}
