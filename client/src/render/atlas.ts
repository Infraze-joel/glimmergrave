/** Canvas atlas for every textured overlay sprite: damage digits, status / door icons and player name labels. */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { NET } from '@shared/constants.ts';

const W = 1024;
const H = 512;
const DIGIT = { W: 44, H: 60, Y: 0 } as const;
const ICON_SIZE = 64;
const ICON_Y = 64;
/** Icons beyond the first row continue here (below the word mark). */
const ICON_Y2 = 400;
const ICONS_PER_ROW = W / ICON_SIZE;
const NAME = { W: 384, H: 56, Y: 144, COLS: 2 } as const;
/** Word mark shown on a Resonance burst; drawn white so the two element colours can tint its halves. */
const WORD = { TEXT: 'RESONANCE', X: 0, Y: 288, W: 560, H: 96 } as const;
const OUTLINE = 'rgba(6, 6, 12, 0.95)';
const FONT_STACK = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

export const ICONS = [
  'burn', 'chill', 'shock', 'stun', 'shield', 'enrage', 'boon', 'blessing', 'cursed', 'boss', 'down', 'marker',
  // update 3
  'wither', 'mark', 'descend', 'ascend', 'bell', 'swift', 'armored', 'volatile', 'vampiric',
  // update 4: element ward, hunt target, and one emblem per chamber objective (survive uses the hourglass)
  'ward', 'hunt', 'survive', 'defend', 'ritual', 'vault',
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
    case 'wither': {
      // a waning crescent: the light eaten away
      ctx.beginPath();
      ctx.arc(c, c, 23, Math.PI * 0.25, Math.PI * 1.75, false);
      ctx.arc(c + 12, c, 17, Math.PI * 1.62, Math.PI * 0.38, true);
      ctx.closePath();
      strokeFill(ctx);
      break;
    }
    case 'mark': {
      // death mark: a reticle with a dagger point
      ctx.lineCap = 'round';
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? OUTLINE : '#ffffff';
        ctx.lineWidth = pass === 0 ? 11 : 5;
        ctx.beginPath(); ctx.arc(c, c, 19, 0, Math.PI * 2); ctx.stroke();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * 13, c + Math.sin(a) * 13);
          ctx.lineTo(c + Math.cos(a) * 27, c + Math.sin(a) * 27);
          ctx.stroke();
        }
      }
      ctx.beginPath(); ctx.moveTo(c, c - 8); ctx.lineTo(c + 6, c); ctx.lineTo(c, c + 8); ctx.lineTo(c - 6, c); ctx.closePath();
      ctx.fillStyle = '#ffffff'; ctx.fill();
      break;
    }
    case 'descend':
    case 'ascend': {
      // stacked chevrons pointing down (the stair into the abyss) or up (the way out)
      const dir = name === 'descend' ? 1 : -1;
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? OUTLINE : '#ffffff';
        ctx.lineWidth = pass === 0 ? 13 : 7;
        ctx.lineJoin = 'miter';
        ctx.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          const y = c + i * 14 * dir;
          const w = 20 - (i + 1) * 4;
          ctx.beginPath();
          ctx.moveTo(c - w, y - 6 * dir); ctx.lineTo(c, y + 6 * dir); ctx.lineTo(c + w, y - 6 * dir);
          ctx.stroke();
        }
      }
      break;
    }
    case 'bell': {
      ctx.beginPath();
      ctx.moveTo(c - 22, 46);
      ctx.quadraticCurveTo(c - 14, 40, c - 14, 26);
      ctx.quadraticCurveTo(c - 14, 10, c, 10);
      ctx.quadraticCurveTo(c + 14, 10, c + 14, 26);
      ctx.quadraticCurveTo(c + 14, 40, c + 22, 46);
      ctx.closePath();
      strokeFill(ctx);
      ctx.beginPath(); ctx.arc(c, 52, 5.5, 0, Math.PI * 2);
      strokeFill(ctx);
      break;
    }
    case 'swift': {
      // double chevron to the right
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? OUTLINE : '#ffffff';
        ctx.lineWidth = pass === 0 ? 13 : 7;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const ox of [-10, 8]) {
          ctx.beginPath();
          ctx.moveTo(c + ox - 8, 14); ctx.lineTo(c + ox + 10, c); ctx.lineTo(c + ox - 8, 50);
          ctx.stroke();
        }
      }
      break;
    }
    case 'armored': {
      // a plate with rivets
      ctx.beginPath();
      ctx.moveTo(c, 6); ctx.lineTo(c + 22, 16); ctx.lineTo(c + 22, 40); ctx.lineTo(c, 58); ctx.lineTo(c - 22, 40); ctx.lineTo(c - 22, 16);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      for (const [dx, dy] of [[-11, 22], [11, 22], [0, 40]]) { ctx.beginPath(); ctx.arc(c + dx, dy, 4, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'volatile': {
      // a bomb with a lit fuse
      ctx.beginPath(); ctx.arc(c - 2, c + 6, 19, 0, Math.PI * 2);
      strokeFill(ctx);
      ctx.beginPath(); ctx.moveTo(c + 9, 16); ctx.lineTo(c + 20, 5); ctx.lineTo(c + 24, 14); ctx.closePath();
      strokeFill(ctx);
      star(ctx, c + 22, 9, 4, 8, 3);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      break;
    }
    case 'ward': {
      // a hollow shield: whatever is drawn inside it is turned away
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? OUTLINE : '#ffffff';
        ctx.lineWidth = pass === 0 ? 12 : 6;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(c - 22, 9); ctx.lineTo(c + 22, 9); ctx.lineTo(c + 22, 31);
        ctx.quadraticCurveTo(c + 19, 51, c, 59); ctx.quadraticCurveTo(c - 19, 51, c - 22, 31);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(6, 6, 12, 0.72)';
      ctx.fill();
      break;
    }
    case 'hunt': {
      // a quarry pin: a pointed drop with a diamond cut out of it
      ctx.beginPath();
      ctx.moveTo(c, 61);
      ctx.bezierCurveTo(c - 8, 44, c - 23, 38, c - 23, 24);
      ctx.bezierCurveTo(c - 23, -2, c + 23, -2, c + 23, 24);
      ctx.bezierCurveTo(c + 23, 38, c + 8, 44, c, 61);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath(); ctx.moveTo(c, 11); ctx.lineTo(c + 11, 24); ctx.lineTo(c, 37); ctx.lineTo(c - 11, 24); ctx.closePath(); ctx.fill();
      break;
    }
    case 'survive': {
      // an hourglass
      ctx.beginPath();
      ctx.moveTo(c - 19, 8); ctx.lineTo(c + 19, 8); ctx.lineTo(c + 19, 15); ctx.lineTo(c + 4, c);
      ctx.lineTo(c + 19, 49); ctx.lineTo(c + 19, 56); ctx.lineTo(c - 19, 56); ctx.lineTo(c - 19, 49);
      ctx.lineTo(c - 4, c); ctx.lineTo(c - 19, 15);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath(); ctx.moveTo(c - 11, 17); ctx.lineTo(c + 11, 17); ctx.lineTo(c, 28); ctx.closePath(); ctx.fill();
      break;
    }
    case 'defend': {
      // the bell shard: a tall crystal on a plinth
      ctx.beginPath();
      ctx.moveTo(c - 2, 4); ctx.lineTo(c + 13, 22); ctx.lineTo(c + 8, 46); ctx.lineTo(c - 10, 46); ctx.lineTo(c - 14, 24);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = 'rgba(6, 6, 12, 0.3)';
      ctx.beginPath(); ctx.moveTo(c - 2, 4); ctx.lineTo(c + 13, 22); ctx.lineTo(c + 8, 46); ctx.lineTo(c - 1, 46); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.rect(c - 20, 50, 40, 8);
      strokeFill(ctx);
      break;
    }
    case 'ritual': {
      // a burning brazier: a bowl on a foot with a flame
      ctx.beginPath();
      ctx.moveTo(c, 4);
      ctx.bezierCurveTo(c + 4, 14, c + 14, 18, c + 11, 30);
      ctx.lineTo(c - 11, 30);
      ctx.bezierCurveTo(c - 14, 22, c - 5, 20, c - 5, 13);
      ctx.bezierCurveTo(c - 1, 16, c, 10, c, 4);
      ctx.closePath();
      strokeFill(ctx);
      ctx.beginPath();
      ctx.moveTo(c - 23, 34); ctx.lineTo(c + 23, 34); ctx.lineTo(c + 12, 47); ctx.lineTo(c + 5, 47); ctx.lineTo(c + 9, 58);
      ctx.lineTo(c - 9, 58); ctx.lineTo(c - 5, 47); ctx.lineTo(c - 12, 47);
      ctx.closePath();
      strokeFill(ctx);
      break;
    }
    case 'vault': {
      // a reliquary chest with a keyhole
      ctx.beginPath();
      ctx.moveTo(c - 24, 30); ctx.quadraticCurveTo(c - 24, 10, c, 10); ctx.quadraticCurveTo(c + 24, 10, c + 24, 30);
      ctx.lineTo(c + 24, 55); ctx.lineTo(c - 24, 55);
      ctx.closePath();
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(c - 24, 28, 48, 4);
      ctx.beginPath(); ctx.arc(c, 39, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(c - 2.5, 40, 5, 10);
      break;
    }
    case 'vampiric': {
      // a falling drop
      ctx.beginPath();
      ctx.moveTo(c, 6);
      ctx.bezierCurveTo(c + 6, 22, c + 20, 30, c + 20, 42);
      ctx.bezierCurveTo(c + 20, 62, c - 20, 62, c - 20, 42);
      ctx.bezierCurveTo(c - 20, 30, c - 6, 22, c, 6);
      ctx.closePath();
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
  /** Left and right half of the word mark, each tinted with one element colour. */
  readonly wordHalves: [UvRect, UvRect];
  readonly wordAspect = WORD.W / WORD.H;
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
      const x = (i % ICONS_PER_ROW) * ICON_SIZE;
      const y = i < ICONS_PER_ROW ? ICON_Y : ICON_Y2;
      drawIcon(ctx, name, x, y);
      this.icons[name] = rect(x, y, ICON_SIZE, ICON_SIZE);
    });

    for (let slot = 0; slot < NET.MAX_PLAYERS; slot++) {
      const x = (slot % NAME.COLS) * (W / NAME.COLS);
      const y = NAME.Y + Math.floor(slot / NAME.COLS) * (NAME.H + 8);
      this.names.push(rect(x, y, NAME.W, NAME.H));
      this.nameText.push('');
    }

    ctx.font = `900 76px ${FONT_STACK}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(WORD.TEXT, WORD.X + WORD.W / 2, WORD.Y + WORD.H / 2 + 2, WORD.W - 28);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(WORD.TEXT, WORD.X + WORD.W / 2, WORD.Y + WORD.H / 2 + 2, WORD.W - 28);
    this.wordHalves = [rect(WORD.X, WORD.Y, WORD.W / 2, WORD.H), rect(WORD.X + WORD.W / 2, WORD.Y, WORD.W / 2, WORD.H)];

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
