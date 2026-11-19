/** Canvas atlas for every textured overlay sprite: damage digits, status / door icons and player name labels. */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { NET } from '@shared/constants.ts';
import { CLASS_IDS } from '@shared/types.ts';
import type { ClassId } from '@shared/types.ts';
import { REACTIONS } from '@shared/data/reactions.ts';

const W = 1024;
const H = 1024;
const DIGIT = { W: 44, H: 60, Y: 0 } as const;
const ICON_SIZE = 64;
const ICON_Y = 64;
/** Icons beyond the first row continue here (below the word mark). */
const ICON_Y2 = 400;
const ICONS_PER_ROW = W / ICON_SIZE;
/** Update 5: one emblem per keystone, two rows between the name labels and the second icon row. */
const EMBLEM_Y = 272;
const NAME = { W: 384, H: 56, Y: 144, COLS: 2 } as const;
/**
 * Word marks shown on a Resonance burst: slot 0 is the common word, slots 1.. the named reactions in REACTIONS order.
 * Drawn white so the two element colours can tint the halves; redrawn whenever the language changes (setWord).
 */
const WORD = { FALLBACK: 'RESONANCE', Y: 512, W: 512, H: 96, COLS: 2, FONT: 66, PAD: 16, STROKE: 13 } as const;
/** Ground aim marker: one cell pair per class (light parts with their dark outline, accent parts), see drawReticle. */
const RETICLE = { SIZE: 72, Y: 920, VIEW: 80, LINE: 4, OUTLINE: 4, GEM: 5 } as const;
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

/** Keystone emblems, in the order they are laid out. Ids are those of shared/data/keystones.ts. */
export const EMBLEMS = [
  'ember_wake', 'shockstep', 'phase_walker', 'ricochet', 'chain_lightning', 'heavy_hitter', 'twin_cast', 'blood_price',
  'orbit_blades', 'familiar', 'colossus', 'corpse_bloom', 'resonance_engine', 'glass_cannon', 'sanguine', 'momentum_engine',
  'ks_knight', 'ks_barbarian', 'ks_mage', 'ks_rogue', 'ks_templar', 'ks_spellblade', 'ks_shade',
] as const;

/** White line art with a dark outline: `lines` are stroked, `fills` are filled. */
function emblemPaths(ctx: CanvasRenderingContext2D, lines: Path2D | null, fills: Path2D | null, width = 5.5): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUTLINE;
  if (lines) { ctx.lineWidth = width + 6; ctx.stroke(lines); }
  if (fills) { ctx.lineWidth = 7; ctx.stroke(fills); }
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  if (fills) ctx.fill(fills);
  if (lines) { ctx.lineWidth = width; ctx.stroke(lines); }
}

function drawEmblem(ctx: CanvasRenderingContext2D, id: string, ox: number, oy: number): void {
  const c = ICON_SIZE / 2;
  const circle = (x: number, y: number, r: number): string => `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  ctx.save();
  ctx.translate(ox, oy);
  switch (id) {
    case 'ember_wake':
      // a flame leaving three streaks behind
      emblemPaths(ctx, new Path2D('M8 22H24M6 34H20M10 46H24'),
        new Path2D('M44 8C48 20 58 26 55 40C52 54 34 54 31 40C29 30 38 28 38 18C42 21 44 15 44 8Z'));
      break;
    case 'shockstep':
      // a boot print of force: a dot and two widening waves
      emblemPaths(ctx, new Path2D('M18 46A20 20 0 0 1 46 18M8 50A32 32 0 0 1 50 8'), new Path2D(circle(42, 42, 8)));
      break;
    case 'phase_walker':
      // a figure stepping through its own outline
      emblemPaths(ctx, new Path2D('M14 12L30 32L14 52Z'), new Path2D('M30 10L52 32L30 54L38 32Z'), 4.5);
      break;
    case 'ricochet':
      emblemPaths(ctx, new Path2D('M8 50L24 18L40 44L54 14M44 13L55 12L56 24'), null, 6);
      break;
    case 'chain_lightning':
      emblemPaths(ctx, new Path2D('M12 14L26 28L20 34L38 40L32 46L52 52'), new Path2D(circle(12, 14, 5) + circle(52, 52, 5) + circle(48, 20, 4.5)), 5);
      break;
    case 'heavy_hitter':
      // a maul
      emblemPaths(ctx, new Path2D('M30 34L12 54'), new Path2D('M26 10L54 24L46 42L18 28Z'), 7);
      break;
    case 'twin_cast':
      emblemPaths(ctx, new Path2D(circle(24, 32, 14) + circle(40, 32, 14)), null, 5.5);
      break;
    case 'blood_price':
      emblemPaths(ctx, null, new Path2D('M32 6C40 22 50 30 50 41A18 17 0 0 1 14 41C14 30 24 22 32 6Z'));
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(23, 39, 18, 5);
      break;
    case 'orbit_blades': {
      let d = circle(c, c, 5);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        const px = c + Math.cos(a) * 20;
        const py = c + Math.sin(a) * 20;
        const tx = -Math.sin(a);
        const ty = Math.cos(a);
        d += `M${(px + tx * 13).toFixed(1)} ${(py + ty * 13).toFixed(1)}L${(px + Math.cos(a) * 6 - tx * 9).toFixed(1)} ${(py + Math.sin(a) * 6 - ty * 9).toFixed(1)}`
          + `L${(px - Math.cos(a) * 5 - tx * 9).toFixed(1)} ${(py - Math.sin(a) * 5 - ty * 9).toFixed(1)}Z`;
      }
      emblemPaths(ctx, null, new Path2D(d));
      break;
    }
    case 'familiar':
      // a wisp with a curling tail and a spark
      emblemPaths(ctx, new Path2D('M26 40C16 46 12 52 20 56M50 10V22M44 16H56'), new Path2D(circle(30, 28, 13)), 5);
      break;
    case 'colossus':
      // broad shoulders, small head
      emblemPaths(ctx, null, new Path2D(`${circle(c, 13, 6)}M8 24H56L48 56H38L32 40L26 56H16Z`));
      break;
    case 'corpse_bloom': {
      let d = circle(c, c, 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        d += circle(c + Math.cos(a) * 17, c + Math.sin(a) * 17, 7);
      }
      emblemPaths(ctx, null, new Path2D(d));
      break;
    }
    case 'resonance_engine': {
      star(ctx, c, c, 8, 26, 18);
      strokeFill(ctx);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.arc(c, c, 8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'glass_cannon':
      emblemPaths(ctx, null, new Path2D('M32 4L54 32L32 60L10 32Z'));
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'miter';
      ctx.stroke(new Path2D('M32 6L26 26L38 34L30 58M38 34L50 30'));
      break;
    case 'sanguine':
      emblemPaths(ctx, null, new Path2D('M32 54C10 38 8 26 12 18C17 9 28 10 32 20C36 10 47 9 52 18C56 26 54 38 32 54Z'));
      break;
    case 'momentum_engine':
      emblemPaths(ctx, new Path2D('M8 14L24 32L8 50M24 14L40 32L24 50M40 14L56 32L40 50'), null, 6.5);
      break;
    case 'ks_knight':
      emblemPaths(ctx, new Path2D('M32 4V12M8 14L14 20M56 14L50 20M4 36H11M60 36H53'),
        new Path2D('M18 20H46V36Q44 50 32 56Q20 50 18 36Z'), 4.5);
      break;
    case 'ks_barbarian':
      emblemPaths(ctx, new Path2D('M32 32C32 26 40 26 40 33C40 42 26 44 22 34C17 20 34 10 46 18C60 28 54 50 36 54C24 56 12 50 9 38'), null, 6);
      break;
    case 'ks_mage':
      emblemPaths(ctx, new Path2D('M24 32H58M30 20L56 14M30 44L56 50'), new Path2D(circle(16, 32, 10)), 6);
      break;
    case 'ks_rogue': {
      let d = '';
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.42;
        d += `M${(c + Math.cos(a) * 12).toFixed(1)} ${(56 + Math.sin(a) * 12).toFixed(1)}L${(c + Math.cos(a) * 48).toFixed(1)} ${(56 + Math.sin(a) * 48).toFixed(1)}`;
      }
      emblemPaths(ctx, new Path2D(d), null, 5);
      break;
    }
    case 'ks_templar':
      emblemPaths(ctx, new Path2D(`${circle(c, c, 24)}M32 16V48M21 27H43`), null, 5.5);
      break;
    case 'ks_spellblade':
      emblemPaths(ctx, new Path2D('M12 50A26 26 0 0 1 30 12M26 54A26 26 0 0 1 44 16M40 58A26 26 0 0 1 58 20'), null, 6);
      break;
    default:
      // ks_shade: a crescent with a blade through it
      emblemPaths(ctx, new Path2D('M46 10L20 54'), new Path2D('M40 8A26 26 0 1 0 56 44A20 20 0 0 1 40 8Z'), 5);
      break;
  }
  ctx.restore();
}

// The class reticles of the aim cursor (game/Cursor.ts draws the same shapes as a CSS cursor), in an 80-unit box.
const RC = RETICLE.VIEW / 2;
const rrad = (deg: number): number => (deg * Math.PI) / 180;
const polar = (r: number, deg: number): string => `${(RC + r * Math.sin(rrad(deg))).toFixed(1)} ${(RC - r * Math.cos(rrad(deg))).toFixed(1)}`;
const QUARTER = [0, 90, 180, 270];
const rline = (r0: number, r1: number, deg: number): string => `M${polar(r0, deg)}L${polar(r1, deg)}`;
const rarc = (r: number, from: number, to: number): string => `M${polar(r, from)}A${r} ${r} 0 0 1 ${polar(r, to)}`;
const rtri = (tip: number, base: number, deg: number, half: number): string => `M${polar(tip, deg)}L${polar(base, deg - half)}L${polar(base, deg + half)}Z`;

interface ReticleShape { stroke: string; fill: string; accentLines?: boolean }
const RETICLES: Record<ClassId, ReticleShape> = {
  knight: { stroke: rarc(14, 0, 180) + rarc(14, 180, 360) + QUARTER.map((d) => rline(20, 28, d)).join(''), fill: '' },
  barbarian: { stroke: '', fill: QUARTER.map((d) => rtri(9, 29, d + 45, 20)).join('') },
  mage: { stroke: rarc(17, 0, 180) + rarc(17, 180, 360), fill: QUARTER.map((d) => `M${polar(27, d + 45)}m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`).join('') },
  rogue: { stroke: QUARTER.map((d) => rline(10, 27, d + 45)).join('') + QUARTER.map((d) => rarc(27, d - 12, d + 12)).join(''), fill: '' },
  templar: { stroke: rline(12, 24, 0) + rline(12, 24, 90) + rline(12, 24, 270) + rline(12, 30, 180), fill: [0, 90, 270].map((d) => rtri(19, 30, d, 20)).join('') + rtri(26, 36, 180, 16), accentLines: true },
  spellblade: { stroke: `M${polar(22, 0)}L${polar(22, 90)}L${polar(22, 180)}L${polar(22, 270)}Z` + QUARTER.map((d) => rline(25, 31, d)).join(''), fill: '' },
  shade: { stroke: rarc(22, 25, 155) + rarc(22, 205, 335) + rline(22, 30, 25) + rline(22, 30, 155) + rline(22, 30, 205) + rline(22, 30, 335), fill: '' },
};

/** layer 0: dark outline and the light parts (centre gem included); layer 1: the parts that take the accent colour. */
function drawReticle(ctx: CanvasRenderingContext2D, cls: ClassId, layer: number, ox: number, oy: number): void {
  const shape = RETICLES[cls];
  const stroke = shape.stroke ? new Path2D(shape.stroke) : null;
  const fill = shape.fill ? new Path2D(shape.fill) : null;
  const fillAccent = !shape.accentLines;
  const strokeAccent = !(fill && !shape.accentLines);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(RETICLE.SIZE / RETICLE.VIEW, RETICLE.SIZE / RETICLE.VIEW);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (layer === 0) {
    ctx.strokeStyle = OUTLINE;
    if (stroke) { ctx.lineWidth = RETICLE.LINE + RETICLE.OUTLINE; ctx.stroke(stroke); }
    if (fill) { ctx.lineWidth = RETICLE.OUTLINE; ctx.stroke(fill); if (!fillAccent) { ctx.fillStyle = '#ffffff'; ctx.fill(fill); } }
    if (stroke && !strokeAccent) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = RETICLE.LINE; ctx.stroke(stroke); }
    const gem = new Path2D(`M${polar(RETICLE.GEM + 2, 0)}L${polar(RETICLE.GEM, 90)}L${polar(RETICLE.GEM + 2, 180)}L${polar(RETICLE.GEM, 270)}Z`);
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3; ctx.stroke(gem);
    ctx.fillStyle = '#ffffff'; ctx.fill(gem);
  } else {
    if (fill && fillAccent) { ctx.fillStyle = '#ffffff'; ctx.fill(fill); }
    if (stroke && strokeAccent) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = RETICLE.LINE; ctx.stroke(stroke); }
  }
  ctx.restore();
}

/** A word mark in the atlas: the two halves of the drawn text and its width / height. */
export interface WordMark { halves: [UvRect, UvRect]; aspect: number }

export class Atlas {
  readonly texture: CanvasTexture;
  readonly digits: UvRect[] = [];
  readonly plus: UvRect;
  readonly bang: UvRect;
  readonly icons = {} as Record<IconName, UvRect>;
  readonly names: UvRect[] = [];
  /** Keystone emblems by keystone id (EMBLEMS). */
  readonly emblems = new Map<string, UvRect>();
  /** Word marks: [0] the common "Resonance", [1..] the reactions in REACTIONS order. Entries are updated in place. */
  readonly words: WordMark[] = [];
  /** Aim-marker reticles per class: [light parts, accent parts]. */
  readonly reticles = {} as Record<ClassId, [UvRect, UvRect]>;
  /** Width / height of a name cell, for sizing the sprite. */
  readonly nameAspect = NAME.W / NAME.H;
  readonly digitAspect = DIGIT.W / DIGIT.H;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly nameText: string[] = [];
  private readonly wordText: string[] = [];

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

    EMBLEMS.forEach((id, i) => {
      const x = (i % ICONS_PER_ROW) * ICON_SIZE;
      const y = EMBLEM_Y + Math.floor(i / ICONS_PER_ROW) * ICON_SIZE;
      drawEmblem(ctx, id, x, y);
      this.emblems.set(id, rect(x, y, ICON_SIZE, ICON_SIZE));
    });

    for (let slot = 0; slot < NET.MAX_PLAYERS; slot++) {
      const x = (slot % NAME.COLS) * (W / NAME.COLS);
      const y = NAME.Y + Math.floor(slot / NAME.COLS) * (NAME.H + 8);
      this.names.push(rect(x, y, NAME.W, NAME.H));
      this.nameText.push('');
    }

    CLASS_IDS.forEach((cls, i) => {
      const pair: UvRect[] = [];
      for (let layer = 0; layer < 2; layer++) {
        const x = (i * 2 + layer) * RETICLE.SIZE;
        drawReticle(ctx, cls, layer, x, RETICLE.Y);
        pair.push(rect(x + 0.5, RETICLE.Y + 0.5, RETICLE.SIZE - 1, RETICLE.SIZE - 1));
      }
      this.reticles[cls] = [pair[0], pair[1]];
    });

    for (let i = 0; i <= REACTIONS.length; i++) {
      this.words.push({ halves: [rect(0, 0, 1, 1), rect(0, 0, 1, 1)], aspect: 1 });
      this.wordText.push('');
      this.drawWord(i, i === 0 ? WORD.FALLBACK : REACTIONS[i - 1].name);
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

  /**
   * Word mark `index` (0 = Resonance, 1.. = REACTIONS order) in the current language. Cheap when nothing changed;
   * otherwise the cell is redrawn and the texture re-uploaded once.
   */
  setWord(index: number, text: string): void {
    if (index < 0 || index >= this.words.length) return;
    if (this.drawWord(index, text)) this.texture.needsUpdate = true;
  }

  private drawWord(index: number, raw: string): boolean {
    const text = raw.trim().toLocaleUpperCase();
    if (text === '' || this.wordText[index] === text) return false;
    this.wordText[index] = text;
    const ctx = this.ctx;
    const x = (index % WORD.COLS) * WORD.W;
    const y = WORD.Y + Math.floor(index / WORD.COLS) * WORD.H;
    ctx.clearRect(x, y, WORD.W, WORD.H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.font = `900 ${WORD.FONT}px ${FONT_STACK}`;
    // long words are set smaller instead of squeezed; umlaut dots count towards the height
    let m = ctx.measureText(text);
    const room = WORD.W - WORD.PAD * 2 - WORD.STROKE;
    const tall = WORD.H - WORD.STROKE - 4;
    const fit = Math.min(1, room / Math.max(1, m.width), tall / Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent));
    if (fit < 1) {
      ctx.font = `900 ${Math.floor(WORD.FONT * fit)}px ${FONT_STACK}`;
      m = ctx.measureText(text);
    }
    const cx = x + WORD.W / 2;
    const base = y + WORD.H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.lineWidth = WORD.STROKE;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(text, cx, base);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, cx, base);
    const w = Math.min(WORD.W, Math.ceil(m.width) + WORD.PAD * 2);
    const word = this.words[index];
    word.halves[0] = rect(cx - w / 2, y, w / 2, WORD.H);
    word.halves[1] = rect(cx, y, w / 2, WORD.H);
    word.aspect = w / WORD.H;
    return true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
