/** Canvas atlas for every textured overlay sprite: damage digits, status / door icons and player name labels. */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { NET } from '@shared/constants.ts';

const W = 1024;
const H = 512;
const DIGIT = { W: 44, H: 60, Y: 0 } as const;
const ICON_SIZE = 64;
const ICON_Y = 64;
const NAME = { W: 384, H: 56, Y: 144, COLS: 2 } as const;
const OUTLINE = 'rgba(6, 6, 12, 0.95)';
const FONT_STACK = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

export const ICONS = [
  'burn', 'chill', 'shock', 'stun', 'shield', 'enrage', 'boon', 'blessing', 'cursed', 'boss', 'down', 'marker',
] as const;
export type IconName = (typeof ICONS)[number];

/** [u0, v0, u1, v1] */
export type UvRect = readonly [number, number, number, number];

const GLYPHS = '0123456789+!';

function rect(x: number, y: number, w: number, h: number): UvRect {
  return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, points: number, outer: number, inner: number, rot = -Math.PI / 2): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i / (points * 2)) * Math.PI * 2;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

function strokeFill(ctx: CanvasRenderingContext2D): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, ox: number, oy: number): void {
  const c = ICON_SIZE / 2;
  ctx.save();
  ctx.translate(ox, oy);
  switch (name) {
    case 'burn': {
      ctx.beginPath();
      ctx.moveTo(c, 8);
      ctx.bezierCurveTo(c + 6, 22, c + 20, 28, c + 16, 44);
      ctx.bezierCurveTo(c + 12, 58, c - 12, 58, c - 16, 44);
      ctx.bezierCurveTo(c - 20, 32, c - 8, 28, c - 8, 18);
      ctx.bezierCurveTo(c - 2, 22, c, 16, c, 8);
      ctx.closePath();
      strokeFill(ctx);
      break;
    }
    case 'chill': {
      ctx.lineCap = 'round';
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? OUTLINE : '#ffffff';
        ctx.lineWidth = pass === 0 ? 11 : 5;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * 22, c + Math.sin(a) * 22);
          ctx.lineTo(c - Math.cos(a) * 22, c - Math.sin(a) * 22);
          ctx.stroke();
        }
      }
      break;
    }
    case 'shock': {
      ctx.beginPath();
      ctx.moveTo(c + 6, 6); ctx.lineTo(c - 14, 34); ctx.lineTo(c - 1, 34); ctx.lineTo(c - 8, 58);
      ctx.lineTo(c + 15, 26); ctx.lineTo(c + 2, 26); ctx.closePath();
      strokeFill(ctx);
      break;
    }
    case 'stun': {
      star(ctx, c, c + 1, 5, 24, 10.5);
      strokeFill(ctx);
      break;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.moveTo(c - 19, 12); ctx.lineTo(c + 19, 12); ctx.lineTo(c + 19, 32);
      ctx.quadraticCurveTo(c + 16, 50, c, 57); ctx.quadraticCurveTo(c - 16, 50, c - 19, 32);
      ctx.closePath();
      strokeFill(ctx);
      break;
    }
    case 'enrage': {
      star(ctx, c, c, 8, 26, 15);
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(c - 3.5, c - 14, 7, 17);
      ctx.fillRect(c - 3.5, c + 7, 7, 7);
      break;
    }
    case 'boon': {
      ctx.beginPath();
      ctx.moveTo(c, 6); ctx.lineTo(c + 20, c); ctx.lineTo(c, 58); ctx.lineTo(c - 20, c); ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = 'rgba(6, 6, 12, 0.28)';
      ctx.beginPath(); ctx.moveTo(c, 6); ctx.lineTo(c + 20, c); ctx.lineTo(c, c); ctx.closePath(); ctx.fill();
      break;
    }
    case 'blessing': {
      ctx.beginPath();
      ctx.moveTo(c, 56);
      ctx.bezierCurveTo(c - 34, 34, c - 22, 4, c, 20);
      ctx.bezierCurveTo(c + 22, 4, c + 34, 34, c, 56);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(c - 3, 23, 6, 20);
      ctx.fillRect(c - 10, 30, 20, 6);
      break;
    }
    case 'cursed':
    case 'boss': {
      // skull (cursed) – the boss icon adds a crown above a smaller skull
      const s = name === 'boss' ? 0.8 : 1;
      const cy = name === 'boss' ? c + 9 : c - 1;
      ctx.beginPath();
      ctx.arc(c, cy - 4 * s, 20 * s, Math.PI * 0.86, Math.PI * 0.14, false);
      ctx.lineTo(c + 11 * s, cy + 22 * s); ctx.lineTo(c - 11 * s, cy + 22 * s);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath(); ctx.arc(c - 8 * s, cy - 3 * s, 5.6 * s, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(c + 8 * s, cy - 3 * s, 5.6 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(c - 1.5 * s, cy + 12 * s, 3 * s, 10 * s);
      if (name === 'boss') {
        ctx.beginPath();
        ctx.moveTo(c - 20, 20); ctx.lineTo(c - 22, 4); ctx.lineTo(c - 10, 12); ctx.lineTo(c, 2);
        ctx.lineTo(c + 10, 12); ctx.lineTo(c + 22, 4); ctx.lineTo(c + 20, 20); ctx.closePath();
        strokeFill(ctx);
      }
      break;
    }
    case 'down': {
      ctx.beginPath();
      ctx.rect(c - 7, 9, 14, 46);
      ctx.rect(c - 23, 25, 46, 14);
      ctx.lineJoin = 'round'; ctx.lineWidth = 7; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(c - 7, 9, 14, 46);
      ctx.fillRect(c - 23, 25, 46, 14);
      break;
    }
    case 'marker': {
      ctx.beginPath();
      ctx.moveTo(c - 18, 16); ctx.lineTo(c + 18, 16); ctx.lineTo(c, 46); ctx.closePath();
      strokeFill(ctx);
      break;
    }
  }
  ctx.restore();
}

export class Atlas {
  readonly texture: CanvasTexture;
  readonly digits: UvRect[] = [];
  readonly plus: UvRect;
  readonly bang: UvRect;
  readonly icons = {} as Record<IconName, UvRect>;
  readonly names: UvRect[] = [];
  /** Width / height of a name cell, for sizing the sprite. */
  readonly nameAspect = NAME.W / NAME.H;
  readonly digitAspect = DIGIT.W / DIGIT.H;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly nameText: string[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 52px ${FONT_STACK}`;
    ctx.lineJoin = 'round';
    for (let i = 0; i < GLYPHS.length; i++) {
      const x = i * DIGIT.W;
      ctx.lineWidth = 9;
      ctx.strokeStyle = OUTLINE;
      ctx.strokeText(GLYPHS[i], x + DIGIT.W / 2, DIGIT.Y + DIGIT.H / 2 + 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(GLYPHS[i], x + DIGIT.W / 2, DIGIT.Y + DIGIT.H / 2 + 2);
      const uv = rect(x + 1, DIGIT.Y, DIGIT.W - 2, DIGIT.H);
      if (i < 10) this.digits.push(uv);
    }
    this.plus = rect(10 * DIGIT.W + 1, DIGIT.Y, DIGIT.W - 2, DIGIT.H);
    this.bang = rect(11 * DIGIT.W + 1, DIGIT.Y, DIGIT.W - 2, DIGIT.H);

    ICONS.forEach((name, i) => {
      drawIcon(ctx, name, i * ICON_SIZE, ICON_Y);
      this.icons[name] = rect(i * ICON_SIZE, ICON_Y, ICON_SIZE, ICON_SIZE);
    });

    for (let slot = 0; slot < NET.MAX_PLAYERS; slot++) {
      const x = (slot % NAME.COLS) * (W / NAME.COLS);
      const y = NAME.Y + Math.floor(slot / NAME.COLS) * (NAME.H + 8);
      this.names.push(rect(x, y, NAME.W, NAME.H));
      this.nameText.push('');
    }

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 4;
  }

  setName(slot: number, text: string): void {
    if (slot < 0 || slot >= this.nameText.length || this.nameText[slot] === text) return;
    this.nameText[slot] = text;
    const ctx = this.ctx;
    const x = (slot % NAME.COLS) * (W / NAME.COLS);
    const y = NAME.Y + Math.floor(slot / NAME.COLS) * (NAME.H + 8);
    ctx.clearRect(x, y, NAME.W, NAME.H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 34px ${FONT_STACK}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(text, x + NAME.W / 2, y + NAME.H / 2 + 1, NAME.W - 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + NAME.W / 2, y + NAME.H / 2 + 1, NAME.W - 16);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
