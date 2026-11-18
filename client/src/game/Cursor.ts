/**
 * Aim cursor for the 3D view. The system arrow disappears among enemies and effects, so while the player is
 * aiming the canvas shows a large, high-contrast reticle instead — and the reticle is part of the game:
 *  - every class has its own shape (a knight's cross, a barbarian's fangs, a mage's orbiting sparks, …)
 *  - the accent takes the colour of the element infused into the primary attack
 *  - it snaps shut while a mouse button is held
 *  - it grows a pulsing crown of sparks while the ultimate is ready
 * It stays a native CSS cursor (inline SVG frames that are swapped), so it follows the mouse without frame delay.
 */
import type { ClassId, ElementId } from '@shared/types.ts';
import type { CursorStyle } from '../core/Settings.ts';

/** Edge length in CSS pixels per style. Browsers ignore cursor images above 128 px. */
const SIZE: Record<Exclude<CursorStyle, 'system'>, number> = { normal: 44, large: 68 };
const COLOR = { light: '#ffffff', dark: '#0b0d14', gold: '#ffcf5a' } as const;
const ELEMENT_COLOR: Record<ElementId, string> = { ember: '#ff8a2a', rime: '#5fe3ff', storm: '#c79bff', umbra: '#9dff8a' };
/** Geometry in an 80-unit box (room for the ultimate sparks around the 64-unit reticle). */
const VIEW = 80;
const C = VIEW / 2;
const OUTLINE = 4;
const LINE = 4;
const GEM = 5;
const SPARK = { RADIUS: 35, SIZE: 4, COUNT: 8 } as const;
/** While a button is held the reticle is scaled towards its centre and turned. */
const PRESS = { SCALE: 0.78, TURN_DEG: 45 } as const;
const PULSE_MS = 280;
const FALLBACK = 'crosshair';

const rad = (deg: number): number => (deg * Math.PI) / 180;
const n = (v: number): string => v.toFixed(1);
const polar = (r: number, deg: number): string => `${n(C + r * Math.sin(rad(deg)))} ${n(C - r * Math.cos(rad(deg)))}`;
const quarter = [0, 90, 180, 270];
const line = (r0: number, r1: number, deg: number): string => `M${polar(r0, deg)}L${polar(r1, deg)}`;
const arc = (r: number, from: number, to: number): string => `M${polar(r, from)}A${r} ${r} 0 0 1 ${polar(r, to)}`;
const triangle = (tip: number, base: number, deg: number, half: number): string =>
  `M${polar(tip, deg)}L${polar(base, deg - half)}L${polar(base, deg + half)}Z`;

/** Stroked and filled parts of a class reticle (paths in the 80-unit box). */
interface Shape { stroke: string; fill: string; /** Accent on the lines instead of the filled parts. */ accentLines?: boolean }

const SHAPES: Record<ClassId, Shape> = {
  // Knight: a steady ring and a plain cross.
  knight: { stroke: arc(14, 0, 180) + arc(14, 180, 360) + quarter.map((d) => line(20, 28, d)).join(''), fill: '' },
  // Barbarian: four fangs biting inward.
  barbarian: { stroke: '', fill: quarter.map((d) => triangle(9, 29, d + 45, 20)).join('') },
  // Mage: a thin ring with four sparks in orbit.
  mage: { stroke: arc(17, 0, 180) + arc(17, 180, 360), fill: quarter.map((d) => `M${polar(27, d + 45)}m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`).join('') },
  // Rogue: an open sniper's X.
  rogue: { stroke: quarter.map((d) => line(10, 27, d + 45)).join('') + quarter.map((d) => arc(27, d - 12, d + 12)).join(''), fill: '' },
  // Templar: a long-stemmed cross with flared ends.
  templar: { stroke: line(12, 24, 0) + line(12, 24, 90) + line(12, 24, 270) + line(12, 30, 180), fill: [0, 90, 270].map((d) => triangle(19, 30, d, 20)).join('') + triangle(26, 36, 180, 16), accentLines: true },
  // Spellblade: a rune diamond with corner cuts.
  spellblade: { stroke: `M${polar(22, 0)}L${polar(22, 90)}L${polar(22, 180)}L${polar(22, 270)}Z` + quarter.map((d) => line(25, 31, d)).join(''), fill: '' },
  // Shade: two crescents closing like a pair of daggers.
  shade: { stroke: arc(22, 25, 155) + arc(22, 205, 335) + line(22, 30, 25) + line(22, 30, 155) + line(22, 30, 205) + line(22, 30, 335), fill: '' },
};

export interface CursorLook {
  cls: ClassId;
  /** Element infused into the primary attack, if any. */
  element: ElementId | null;
  pressed: boolean;
  /** Ultimate is ready. */
  charged: boolean;
}

function reticleSvg(size: number, look: CursorLook, pulse: boolean): string {
  const shape = SHAPES[look.cls];
  const accent = look.element ? ELEMENT_COLOR[look.element] : COLOR.gold;
  const body = look.pressed ? ` transform="rotate(${PRESS.TURN_DEG} ${C} ${C}) translate(${C} ${C}) scale(${PRESS.SCALE}) translate(${-C} ${-C})"` : '';
  const gem = `M${polar(GEM + 2, 0)}L${polar(GEM, 90)}L${polar(GEM + 2, 180)}L${polar(GEM, 270)}Z`;
  let sparks = '';
  if (look.charged) {
    const offset = pulse ? 180 / SPARK.COUNT : 0;
    const reach = pulse ? SPARK.RADIUS : SPARK.RADIUS - 3;
    for (let i = 0; i < SPARK.COUNT; i++) {
      const deg = (360 / SPARK.COUNT) * i + offset;
      sparks += `M${polar(reach + SPARK.SIZE, deg)}L${polar(reach, deg + 5)}L${polar(reach - SPARK.SIZE, deg)}L${polar(reach, deg - 5)}Z`;
    }
  }
  const outline = `stroke="${COLOR.dark}" stroke-width="${LINE + OUTLINE}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + (sparks ? `<path d="${sparks}" fill="${COLOR.gold}" stroke="${COLOR.dark}" stroke-width="2"/>` : '')
    + `<g${body}>`
    + (shape.stroke ? `<path d="${shape.stroke}" ${outline}/>` : '')
    + (shape.fill ? `<path d="${shape.fill}" fill="${shape.accentLines ? COLOR.light : accent}" stroke="${COLOR.dark}" stroke-width="${OUTLINE}"/>` : '')
    + (shape.stroke ? `<path d="${shape.stroke}" stroke="${shape.fill && !shape.accentLines ? COLOR.light : accent}" stroke-width="${LINE}"/>` : '')
    + '</g>'
    + `<path d="${gem}" fill="${COLOR.light}" stroke="${COLOR.dark}" stroke-width="3"/>`
    + '</svg>';
}

/** CSS `cursor` value for a look; the hotspot is the centre of the reticle. */
export function cursorCss(style: CursorStyle, look: CursorLook, pulse = false): string {
  if (style === 'system') return 'default';
  const size = SIZE[style];
  const hot = Math.round(size / 2);
  return `url("data:image/svg+xml,${encodeURIComponent(reticleSvg(size, look, pulse))}") ${hot} ${hot}, ${FALLBACK}`;
}

/** Keeps the canvas cursor in step with the hero: call the setters whenever something changes. */
export class AimCursor {
  private style: CursorStyle = 'normal';
  private aiming = false;
  private readonly look: CursorLook = { cls: 'knight', element: null, pressed: false, charged: false };
  private pulse = false;
  private timer = 0;
  private readonly cache = new Map<string, string>();
  private readonly canvas: HTMLCanvasElement;
  private readonly onDown = (): void => this.patch({ pressed: true });
  private readonly onUp = (): void => this.patch({ pressed: false });

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('blur', this.onUp);
  }

  setStyle(style: CursorStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.refresh();
  }

  setAiming(aiming: boolean): void {
    if (aiming === this.aiming) return;
    this.aiming = aiming;
    if (!aiming) this.look.pressed = false;
    this.refresh();
  }

  /** Changes parts of the look; cheap to call every frame (nothing happens unless a value differs). */
  patch(next: Partial<CursorLook>): void {
    const look = this.look;
    const cls = next.cls ?? look.cls;
    const element = next.element === undefined ? look.element : next.element;
    const pressed = next.pressed ?? look.pressed;
    const charged = next.charged ?? look.charged;
    if (cls === look.cls && element === look.element && pressed === look.pressed && charged === look.charged) return;
    look.cls = cls;
    look.element = element;
    look.pressed = pressed;
    look.charged = charged;
    this.refresh();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('blur', this.onUp);
    this.canvas.style.cursor = '';
  }

  private refresh(): void {
    const animate = this.aiming && this.look.charged && this.style !== 'system';
    if (animate && this.timer === 0) {
      this.timer = window.setInterval(() => { this.pulse = !this.pulse; this.draw(); }, PULSE_MS);
    } else if (!animate && this.timer !== 0) {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.pulse = false;
    }
    this.draw();
  }

  private draw(): void {
    let value = '';
    if (this.aiming) {
      const look = this.look;
      const key = `${this.style}|${look.cls}|${look.element ?? ''}|${look.pressed ? 1 : 0}|${look.charged ? (this.pulse ? 2 : 1) : 0}`;
      value = this.cache.get(key) ?? '';
      if (!value) {
        value = cursorCss(this.style, look, this.pulse);
        this.cache.set(key, value);
      }
    }
    if (this.canvas.style.cursor !== value) this.canvas.style.cursor = value;
  }
}
