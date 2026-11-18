/**
 * Original inline SVG icon set. One consistent style: 24x24 grid, round 1.7px strokes in currentColor,
 * occasional soft fills (class "f") for weight. No external images.
 */
const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const SOFT = 'fill="currentColor" fill-opacity="0.22"';
const SOLID = 'fill="currentColor" stroke="none"';

const spokes = (count: number, d: string): string =>
  Array.from({ length: count }, (_, i) => `<path transform="rotate(${(360 / count) * i} 12 12)" d="${d}"/>`).join('');

const SWORD =
  `<path ${SOFT} d="M20.5 3.5l-4 .7-8.9 8.9 3.3 3.3 8.9-8.9z"/><path d="M5.6 11.3l7.1 7.1"/><path d="M7.7 16.3l-3.4 3.4"/>`;
const SHIELD = `<path ${SOFT} d="M12 3l7.5 2.6v5.9c0 4.6-3 8-7.5 9.5-4.5-1.5-7.5-4.9-7.5-9.5V5.6z"/>`;
const SKULL =
  `<path ${SOFT} d="M12 3.5c-4.4 0-7.5 3-7.5 7 0 2.3 1 4.1 2.5 5.3V19h10v-3.2c1.5-1.2 2.5-3 2.5-5.3 0-4-3.1-7-7.5-7z"/>` +
  `<circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 19v-2.2M12 19v-2.2M14 19v-2.2"/>`;
const CROWN = `<path ${SOFT} d="M4 18.5L2.8 8.2l5 4L12 5l4.2 7.2 5-4L20 18.5z"/><path d="M4.5 21.2h15"/>`;
const FLAME =
  `<path ${SOFT} d="M12 2.5c.7 3.3 5.6 5.6 5.6 11a5.6 5.6 0 0 1-11.2 0c0-2.3 1.2-3.9 2.3-5 .3 1.6 1 2.5 1.9 2.9-.2-3.3 0-6.4 1.4-8.9z"/>` +
  `<path d="M12 19.2a2.3 2.3 0 0 1-2.3-2.3c0-1.3 1.2-2 2.3-3.4 1.1 1.4 2.3 2.1 2.3 3.4a2.3 2.3 0 0 1-2.3 2.3z"/>`;
const SNOW = spokes(6, 'M12 12V2.8M9.8 4.9L12 7.1l2.2-2.2');
const BOLT = `<path ${SOFT} d="M13.6 2.5L5.5 13.6h5.1l-1.6 7.9 8.6-11.6h-5.2z"/>`;
const RESONANCE =
  `<circle cx="12" cy="12" r="3" ${SOFT}/><circle cx="12" cy="12" r="6.8" stroke-dasharray="2.6 2.6"/>` +
  `<path d="M12 1.6v2.6M12 19.8v2.6M1.6 12h2.6M19.8 12h2.6"/>`;
const HEART = `<path ${SOFT} d="M12 20.2S4.5 15.6 4.5 9.9A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.6c0 5.7-7.5 10.3-7.5 10.3z"/>`;
const GEM = `<path ${SOFT} d="M7 4h10l4 5.5L12 21 3 9.5z"/><path d="M3 9.5h18M9.2 4L7.6 9.5 12 21l4.4-11.5L14.8 4"/>`;
const BOOT = `<path ${SOFT} d="M8.5 3.5v9.2l-4 3v4.3h15.5v-2.4c0-2-1.6-3.2-4-3.5l-2.5-1.6v-9z"/><path d="M4.5 17.2H20"/>`;
const MOUSE_BODY = '<path d="M7 9a5 5 0 0 1 10 0v6a5 5 0 0 1-10 0z"/><path d="M12 4v6M7 10h10"/>';

export const ICONS = {
  // ---- abilities
  sword: wrap(SWORD),
  bash: wrap(`<g transform="translate(3 0)">${SHIELD}</g><path d="M2 8.5h3M1.5 12h4M2 15.5h3"/>`),
  axe: wrap(`<path d="M4.5 20.5L16 6"/><path ${SOFT} d="M13.2 4.4c2.6-.9 5.6.2 7.2 2.6-1.2 2.7-3.7 4.4-6.5 4.5l-2.8-3.6z"/>`),
  whirl: wrap(
    '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2"/><path d="M17.8 2.8v4.1h-4.1"/>' +
    '<path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2"/><path d="M6.2 21.2v-4.1h4.1"/>' +
    `<circle cx="12" cy="12" r="1.6" ${SOFT}/>`,
  ),
  arcBolt: wrap(`<circle cx="16" cy="8" r="3.6" ${SOFT}/><path d="M12.9 11.1L5 19M10.4 8.6l-5.2 5.2M15.4 13.6l-5.2 5.2"/>`),
  nova: wrap(`<circle cx="12" cy="12" r="4.2" ${SOFT}/>${spokes(8, 'M12 2.4v2.8')}`),
  crossbow: wrap('<path d="M4 10c4-5.5 12-5.5 16 0"/><path d="M4 10l8 4 8-4"/><path d="M12 3v18"/><path d="M9.8 5.2L12 3l2.2 2.2"/>'),
  knives: wrap(
    [-38, 0, 38].map((a) =>
      `<g transform="rotate(${a} 12 21)"><path ${SOFT} d="M12 2.5l1.7 9h-3.4z"/><path d="M12 11.5v4.5"/></g>`).join(''),
  ),
  dash: wrap('<path d="M12.5 5l7 7-7 7"/><path d="M5.5 5l7 7-7 7"/>'),

  // ---- elements
  ember: wrap(FLAME),
  rime: wrap(SNOW),
  storm: wrap(BOLT),
  resonance: wrap(RESONANCE),

  // ---- class emblems
  knight: wrap(`<path ${SOFT} d="M6 21V10.5C6 6.4 8.7 3.5 12 3.5s6 2.9 6 7V21h-4.4L12 17.8 10.4 21z"/><path d="M6 11.5h12M12 11.5v4"/>`),
  barbarian: wrap(
    `<path ${SOFT} d="M6.5 20.5v-6a5.5 5.5 0 0 1 11 0v6z"/><path d="M12 14.5v6"/>` +
    '<path d="M6.9 12.3C4 11.8 2.8 9.4 3 6.4c1.4 1.8 3 2.6 4.9 2.9"/><path d="M17.1 12.3c2.9-.5 4.1-2.9 3.9-5.9-1.4 1.8-3 2.6-4.9 2.9"/>',
  ),
  mage: wrap(
    `<path ${SOFT} d="M7.3 17.3L13 3.5l1.2 5 2.5 8.8"/>` +
    '<path d="M3.5 18.6c2.5-1.2 5.4-1.8 8.5-1.8s6 .6 8.5 1.8c-2 1.6-5 2.4-8.5 2.4s-6.5-.8-8.5-2.4z"/><path d="M9.6 12.6h5.8"/>',
  ),
  rogue: wrap(
    `<path ${SOFT} d="M12 3C7.5 4.8 5 8.7 5 13.5c0 3 1 5.5 2.5 7.5h9c1.5-2 2.5-4.5 2.5-7.5C19 8.7 16.5 4.8 12 3z"/>` +
    '<path d="M8.6 14.2c0-2.6 1.5-4.6 3.4-4.6s3.4 2 3.4 4.6c0 1.5-.5 2.8-1.2 3.8h-4.4c-.7-1-1.2-2.3-1.2-3.8z"/>',
  ),

  // ---- doors + chambers
  boon: wrap(GEM),
  blessing: wrap(`<path ${SOFT} d="M7 4.5h10v3.8a5 5 0 0 1-10 0z"/><path d="M12 13.3v5.2M8 20.8h8"/><path d="M12 1.2v1.3"/>`),
  cursed: wrap(
    `<path ${SOFT} d="M2.5 12c2.5-4.5 5.8-6.8 9.5-6.8s7 2.3 9.5 6.8c-2.5 4.5-5.8 6.8-9.5 6.8S5 16.5 2.5 12z"/>` +
    '<path d="M12 8.3c1.4 1.2 1.4 6.2 0 7.4-1.4-1.2-1.4-6.2 0-7.4z"/>',
  ),
  boss: wrap(CROWN),
  combat: wrap('<path d="M5 4l11.5 11.5M19 4L7.5 15.5"/><path d="M13.8 17.2l3.4-3.4M10.2 17.2l-3.4-3.4"/><path d="M17 17l3 3M7 17l-3 3"/>'),
  elite: wrap(SKULL),

  // ---- boon categories + rarity
  infusion: wrap(`<path ${SOFT} d="M12 3c3 4 6 7 6 10.6a6 6 0 0 1-12 0C6 10 9 7 12 3z"/><path d="M9.3 14.2a2.8 2.8 0 0 0 2.2 2.6"/>`),
  offense: wrap(SWORD),
  defense: wrap(`${SHIELD}<path d="M12 8v7M8.6 11.5h6.8"/>`),
  mobility: wrap(BOOT),
  element: wrap(
    `<circle cx="12" cy="6.2" r="2.7" ${SOFT}/><circle cx="6" cy="16.8" r="2.7" ${SOFT}/><circle cx="18" cy="16.8" r="2.7" ${SOFT}/>` +
    '<path d="M10.6 8.6l-3.2 5.8M13.4 8.6l3.2 5.8M8.8 16.8h6.4"/>',
  ),
  kinship: wrap(`<circle cx="8.8" cy="12" r="5.2" ${SOFT}/><circle cx="15.2" cy="12" r="5.2"/>`),
  gem: wrap(`<path ${SOFT} d="M12 2.8l7 9.2-7 9.2-7-9.2z"/><path d="M5 12h14M12 2.8L9.2 12l2.8 9.2 2.8-9.2z"/>`),

  // ---- stats
  heart: wrap(HEART),
  speed: wrap(BOOT),
  skull: wrap(SKULL),
  revive: wrap(`${HEART}<path d="M12 15.5v-5M9.8 12.4l2.2-2.2 2.2 2.2"/>`),
  down: wrap('<path d="M12 4v14M6.5 12.5L12 18l5.5-5.5"/><path d="M5 21h14"/>'),
  star: wrap(`<path ${SOFT} d="M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3l-5.6 3 1.2-6.3L3 9.6l6.3-.8z"/>`),
  hourglass: wrap(`<path d="M6.5 3h11M6.5 21h11"/><path ${SOFT} d="M7.5 3c0 4.5 4.5 5.5 4.5 9s-4.5 4.5-4.5 9h9c0-4.5-4.5-5.5-4.5-9s4.5-4.5 4.5-9z"/>`),
  bell: wrap(`<path ${SOFT} d="M5.5 17c1.4-1.3 1.8-3.2 1.8-6.5a4.7 4.7 0 0 1 9.4 0c0 3.3.4 5.2 1.8 6.5z"/><path d="M10.3 20a1.8 1.8 0 0 0 3.4 0M12 5.8V3.6"/>`),
  users: wrap(`<circle cx="9" cy="8.5" r="3.2" ${SOFT}/><path d="M3 20c.4-3.6 2.8-5.6 6-5.6s5.6 2 6 5.6"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c2 .7 3.2 2.5 3.5 5.2"/>`),

  // ---- interface
  check: wrap('<path d="M5 12.6l4.6 4.6L19 7.6"/>'),
  close: wrap('<path d="M6 6l12 12M18 6L6 18"/>'),
  copy: wrap(`<rect x="8.5" y="8.5" width="11" height="11" rx="1.5" ${SOFT}/><path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1"/>`),
  link: wrap('<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.2 1.2"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.2-1.2"/>'),
  unlink: wrap('<path d="M13.5 6.5L15 5a4.2 4.2 0 0 1 6 6l-1.5 1.5"/><path d="M10.5 17.5L9 19a4.2 4.2 0 0 1-6-6l1.5-1.5"/><path d="M4 4l16 16"/>'),
  gear: wrap(`<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="6.6" ${SOFT}/>${spokes(8, 'M12 2.6v2.8')}`),
  help: wrap(`<circle cx="12" cy="12" r="9" ${SOFT}/><path d="M9.3 9.4a2.8 2.8 0 1 1 4.2 2.4c-.9.6-1.5 1.2-1.5 2.4"/><path d="M12 17.3v.2"/>`),
  exit: wrap('<path d="M14 4h5.5v16H14"/><path d="M10.5 8l-4 4 4 4M6.5 12h9"/>'),
  lock: wrap(`<rect x="5.5" y="10.5" width="13" height="10" rx="1.5" ${SOFT}/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2.5"/>`),
  warning: wrap(`<path ${SOFT} d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.3v.2"/>`),
  move: wrap('<path d="M12 3v18M3 12h18"/><path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5"/>'),
  door: wrap(`<path ${SOFT} d="M6 21V8.5a6 6 0 0 1 12 0V21z"/><path d="M3.5 21h17M14.5 14v1.5"/>`),
  mouseLeft: wrap(`${MOUSE_BODY}<path ${SOLID} d="M11.2 4.1A5 5 0 0 0 7 9v.2h4.2z"/>`),
  mouseRight: wrap(`${MOUSE_BODY}<path ${SOLID} d="M12.8 4.1A5 5 0 0 1 17 9v.2h-4.2z"/>`),
  mouse: wrap(MOUSE_BODY),
  signal: wrap('<path class="b1" d="M5 20v-3"/><path class="b2" d="M10 20v-7"/><path class="b3" d="M15 20V9"/><path class="b4" d="M20 20V4"/>'),

  // ---- update 2: progression, training, codex
  glimmer: wrap(`<path ${SOFT} d="M12 2.5l6 7.5-6 11.5-6-11.5z"/><path d="M6 10h12M12 2.5l-2.2 7.500 2.2 11.500 2.200-11.500z"/>`),
  training: wrap(`<circle cx="12" cy="12" r="8.8" ${SOFT}/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" ${SOLID}/>`),
  armory: wrap(`<path ${SOFT} d="M4 9h13.5c1.6 0 3 .7 3.5 2-1.2 1.4-3 2-5 2h-1.2c.2 1.7 1 3 2.7 4v2H6.5v-2c1.7-1 2.5-2.3 2.7-4C6.6 13 4.6 11.500 4 9z"/><path d="M8 5.200l3-2 3 2"/>`),
  wardrobe: wrap(`<path d="M12 7.5a2 2 0 1 0-2-2"/><path ${SOFT} d="M12 7.500v2l8.500 6.200c.8.600.4 1.800-.6 1.800H4.100c-1 0-1.400-1.200-.6-1.800L12 9.500"/>`),
  codex: wrap(`<path ${SOFT} d="M4.500 4.500h6c1 0 1.500.5 1.500 1.500v14c0-.9-.6-1.500-1.500-1.500h-6z"/><path ${SOFT} d="M19.500 4.500h-6c-1 0-1.500.5-1.500 1.500v14c0-.9.6-1.500 1.500-1.500h6z"/><path d="M7 8.500h2.500M7 11.500h2.500M14.500 8.500H17M14.500 11.500H17"/>`),
  reroll: wrap(`<rect x="4" y="4" width="16" height="16" rx="2.500" ${SOFT}/><circle cx="8.600" cy="8.600" r="1.100" ${SOLID}/><circle cx="15.400" cy="8.600" r="1.100" ${SOLID}/><circle cx="12" cy="12" r="1.100" ${SOLID}/><circle cx="8.600" cy="15.400" r="1.100" ${SOLID}/><circle cx="15.400" cy="15.400" r="1.100" ${SOLID}/>`),
  shuffle: wrap('<path d="M3 7h3.500c5 0 6 10 11 10H21"/><path d="M3 17h3.500c1.700 0 2.900-1.100 4-2.600M13.500 9.600c1.100-1.500 2.300-2.600 4-2.600H21"/><path d="M18.500 4.500L21 7l-2.500 2.500M18.500 14.500L21 17l-2.500 2.500"/>'),
  tip: wrap(`<path ${SOFT} d="M12 3a6 6 0 0 0-3.500 10.900c.6.500 1 1.200 1 2V17h5v-1.100c0-.8.4-1.500 1-2A6 6 0 0 0 12 3z"/><path d="M9.800 20.500h4.400M12 13.500v-3"/>`),
  arrow: wrap('<path d="M4 12h15M13.500 6.500L19 12l-5.500 5.500"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  eye: wrap(`<path ${SOFT} d="M2.500 12c2.500-4.300 5.800-6.500 9.500-6.500s7 2.200 9.500 6.500c-2.500 4.300-5.800 6.500-9.500 6.500S5 16.300 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>`),
  cape: wrap(`<path ${SOFT} d="M8.500 4h7l3.500 16c-2.300-1.300-4.700-1.300-7 0-2.300-1.300-4.700-1.300-7 0z"/><path d="M8.500 4c.5 1.500 1.700 2.300 3.500 2.300s3-.8 3.500-2.300"/>`),
  helmet: wrap(`<path ${SOFT} d="M5 19v-7.500a7 7 0 0 1 14 0V19h-5v-5.500h-4V19z"/><path d="M12 4.500V2.500M5 12.500h14"/>`),
  matron: wrap(`<path ${SOFT} d="M12 3c-3.500 2-5.500 5-5.500 8.500 0 2.300.8 4.300 2 5.800L7 21h10l-1.500-3.700c1.200-1.500 2-3.500 2-5.800C17.500 8 15.500 5 12 3z"/><circle cx="12" cy="11" r="2.200"/><path d="M12 8.800v-2M3.500 8.500l2 1M20.500 8.500l-2 1"/>`),
  stalker: wrap(`<path ${SOFT} d="M4 6.500l5 2.500h6l5-2.500-2 6.500c-.6 2-1.600 3.600-3 4.700V21h-6v-3.300c-1.400-1.100-2.400-2.700-3-4.700z"/><path d="M9.300 12.500l1.700.8M14.700 12.500l-1.700.8M11 21v-1.800M13 21v-1.800"/>`),
  spikes: wrap(`<path ${SOFT} d="M3 20l3-11 3 11zM9 20l3-15 3 15zM15 20l3-11 3 11z"/><path d="M2.500 20.500h19"/>`),
  vent: wrap(`<path d="M4 20.500h16M6.500 20.500v-2.500h11v2.500"/><path ${SOFT} d="M12 3c.5 2.300 3.800 3.900 3.800 7.600a3.800 3.800 0 0 1-7.600 0c0-1.600.8-2.700 1.600-3.500.2 1.100.7 1.700 1.300 2-.1-2.300 0-4.400.9-6.100z"/>`),
  frost: wrap(`<g transform="translate(12 10) scale(0.72) translate(-12 -12)">${SNOW}</g><path d="M4 20.500c1.300-1 2.700-1 4 0s2.700 1 4 0 2.700-1 4 0 2.700 1 4 0"/>`),

  // ---- update 3: umbra, new classes, abilities, doors, progression
  umbra: wrap(`<path ${SOFT} d="M15.5 3.2a9 9 0 1 0 5.3 15.4A7.6 7.6 0 0 1 15.5 3.2z"/><circle cx="16.8" cy="9.6" r="1.1" ${SOLID}/><path d="M12.6 13.6l1 1M9.4 10.2l.6.6"/>`),
  templar: wrap(`<path ${SOFT} d="M6 21V9.500L12 3l6 6.500V21h-4v-4h-4v4z"/><path d="M12 7.500v7M9.300 10.300h5.400"/>`),
  spellblade: wrap(`<path ${SOFT} d="M4 6.500h7v12H4z"/><path d="M6.200 9.500h2.600M6.200 12.500h2.600"/><path d="M20 3.500l-1 6-5.500 8.500-2-1.300L17 8.200z" ${SOFT}/><path d="M11 15.500l4 2.600M12 19.500l-1.500 2"/>`),
  shade: wrap(`<path ${SOFT} d="M12 3c-4 0-7 3.200-7 7.500 0 4 1.500 7.500 3.500 10.500l3.500-2.500 3.500 2.500c2-3 3.500-6.500 3.500-10.500C19 6.200 16 3 12 3z"/><path d="M8.300 11.500l2.400 1.200M15.700 11.500l-2.400 1.200"/>`),
  greatsword: wrap(`<path ${SOFT} d="M12 2.500l2 3.500v9h-4V6z"/><path d="M7.500 15h9M12 15v4.500"/><circle cx="12" cy="20.500" r="1.100"/>`),
  disc: wrap(`<circle cx="14" cy="12" r="6.500" ${SOFT}/><circle cx="14" cy="12" r="2.200"/><path d="M2 8.500h4M1.500 12h4.500M2 15.500h4"/>`),
  banner: wrap(`<path d="M6 21.500V3"/><path ${SOFT} d="M6 4h12.500l-3 4.500 3 4.500H6z"/><path d="M4 21.500h4"/>`),
  leap: wrap(`<path d="M3.500 17c2-9 9-12 15-7"/><path d="M14.500 9.200l4.200.9-.9 4.200"/><path d="M13 20.500h8M15 17.500l2 3 2-3"/>`),
  rage: wrap(`${FLAME}<path d="M4 6l2 2M20 6l-2 2M3 13h2.200M18.800 13H21"/>`),
  beam: wrap(`<circle cx="5.500" cy="12" r="2.500" ${SOFT}/><path d="M8.500 12H22"/><path d="M10 8.500h9M10 15.500h9" stroke-opacity=".55"/>`),
  meteor: wrap(`<circle cx="15.500" cy="15.500" r="5" ${SOFT}/><path d="M11.500 11.500L4 4M14 8.500L9.500 3M8.500 14L3 9.500"/>`),
  trap: wrap(`<path ${SOFT} d="M3.500 17a8.500 8.500 0 0 1 17 0z"/><path d="M6.500 17l1.300-3.500L9.500 17l1.200-4 1.300 4 1.300-4 1.200 4 1.700-3.500 1.300 3.500"/><path d="M2.500 20h19"/>`),
  volley: wrap([5.500, 12, 18.500].map((x, i) => `<path d="M${x} ${3 + i * 1.500}v${12 - i}M${x - 2} ${12.500 + i * 0.500}l2 2.500 2-2.500"/>`).join('') + `<ellipse cx="12" cy="20" rx="8.500" ry="1.800" ${SOFT}/>`),
  consecrate: wrap(`<ellipse cx="12" cy="17" rx="9" ry="3.800" ${SOFT}/><path d="M12 3v10M8.500 6.500h7"/><path d="M5.500 12.500v1.500M18.500 12.500v1.500"/>`),
  judgement: wrap(`<path ${SOFT} d="M7 3.500h10v5H7z"/><path d="M12 8.500V17"/><path d="M4 20.500c2.500-2.500 5-3.500 8-3.500s5.500 1 8 3.500"/><path d="M6.500 12l-2 1.500M17.500 12l2 1.500"/>`),
  sanctuary: wrap(`<path ${SOFT} d="M4 20.500v-7a8 8 0 0 1 16 0v7z"/><path d="M12 9v7M9.300 12h5.400"/><path d="M2.500 20.500h19"/>`),
  bladeWave: wrap(`<path ${SOFT} d="M8 3.500c6 2 9 5.500 9 8.500s-3 6.500-9 8.500c3-3 4-5.500 4-8.500s-1-5.500-4-8.500z"/><path d="M3 8.500h4M2.500 12h5M3 15.500h4"/>`),
  blink: wrap(`<path d="M3 12h4M9.500 12h2"/><path ${SOFT} d="M14 6.500l7 5.500-7 5.500 2-5.500z"/><path d="M5 7.500l1.500 1M5 16.500l1.500-1"/>`),
  ward: wrap(`<circle cx="12" cy="12" r="8.500" stroke-dasharray="3.500 3"/><path ${SOFT} d="M12 7l4 2v3.500c0 2.300-1.600 4-4 4.800-2.400-.8-4-2.500-4-4.800V9z"/>`),
  overload: wrap(`<circle cx="12" cy="12" r="9" stroke-dasharray="2 3.200"/><g transform="translate(12 12) scale(.62) translate(-12 -12)">${BOLT}</g>`),
  daggers: wrap(`<path ${SOFT} d="M5 3.500l3.500 9-2.300 1z"/><path d="M5.200 15.200l4.300-1.800M8 15l1.500 3.500"/><path ${SOFT} d="M19 3.500l-3.500 9 2.300 1z"/><path d="M18.800 15.200l-4.300-1.800M16 15l-1.500 3.500"/>`),
  shadowstep: wrap(`<path ${SOFT} d="M13 4.500l7.500 7.500-7.500 7.500 2.500-7.500z"/><path d="M9 6.500l-1.500 5.500 1.500 5.500" stroke-opacity=".7"/><path d="M5 8.500L4 12l1 3.500" stroke-opacity=".4"/>`),
  smoke: wrap(`<circle cx="8.500" cy="13.500" r="4.500" ${SOFT}/><circle cx="15" cy="10.500" r="5" ${SOFT}/><circle cx="16" cy="16" r="3.500"/><path d="M4 20.500h16"/>`),
  mark: wrap(`<circle cx="12" cy="12" r="7.500"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><path ${SOFT} d="M12 9l2 3-2 3-2-3z"/>`),
  ultimate: wrap(`<path ${SOFT} d="M12 2.500l2.600 6.300 6.900.5-5.300 4.400 1.700 6.800L12 16.800 6.100 20.500l1.700-6.800L2.500 9.300l6.900-.5z"/><circle cx="12" cy="12" r="2" ${SOLID}/>`),
  class: wrap(`${SHIELD}<path d="M9 11.500l2.200 2.200L15.200 9.500"/>`),
  duo: wrap(`<path ${SOFT} d="M8 4l5 8-5 8-5-8z"/><path ${SOFT} d="M16 4l5 8-5 8-5-8z"/>`),
  descend: wrap(`<path ${SOFT} d="M4 3.500h16v4H4z"/><path d="M12 9.500v9M7.500 14.500L12 19l4.500-4.500"/><path d="M5 21.500h14" stroke-opacity=".5"/>`),
  ascend: wrap(`<path d="M12 21V8.500M7.500 12.500L12 8l4.500 4.500"/><path ${SOFT} d="M7 5.500a5 5 0 0 1 10 0z"/><path d="M12 2v1.200M5 3.500l.9.9M19 3.500l-.9.9"/>`),
  depth: wrap(`<path d="M4 5h16M6.500 10h11M9 15h6"/><path ${SOFT} d="M12 22l-2.500-4h5z"/>`),
  ascension: wrap(`<path ${SOFT} d="M12 3l7 9h-4v8.500H9V12H5z"/><path d="M4 21.500h16" stroke-opacity=".5"/>`),
  mastery: wrap(`<path ${SOFT} d="M12 2.500l2.300 4.700 5.200.7-3.800 3.600.9 5.200L12 14.200l-4.600 2.500.9-5.200L4.500 7.900l5.200-.7z"/><path d="M8 18.500l-1.500 3 5.500-2 5.500 2-1.500-3"/>`),
  relic: wrap(`<path ${SOFT} d="M7 9.500h10l-1.200 11H8.200z"/><path d="M9 9.500V7a3 3 0 0 1 6 0v2.500"/><path d="M12 13l1.800 2.300L12 17.600l-1.800-2.300z"/>`),
  shard: wrap(`<path ${SOFT} d="M10 3l6 6-3 12-6-8z"/><path d="M10 3l1.500 7.500L13 21M7 13l4.500-2.500L16 9"/>`),
  chronicle: wrap(`<path ${SOFT} d="M6 3.500h10.500a2 2 0 0 1 2 2V20.500H7.500a1.500 1.500 0 0 1-1.500-1.500z"/><path d="M9.500 8h5.500M9.500 11.500h5.500M9.500 15h3"/><path d="M6 17.500h12.500"/>`),
  trophy: wrap(`<path ${SOFT} d="M7.500 4h9v5.500a4.500 4.500 0 0 1-9 0z"/><path d="M7.500 5.500H4.500c0 3 1.200 4.500 3.300 5M16.500 5.500h3c0 3-1.200 4.500-3.300 5"/><path d="M12 14v4M8.500 20.500h7"/>`),
  talent: wrap(`<path d="M12 21v-7"/><path ${SOFT} d="M12 14c-4 0-6.500-2.500-6.500-6.500C9.500 7.500 12 10 12 14z"/><path ${SOFT} d="M12 11c0-4 2.500-7 6.500-7.500 0 4.500-2.500 7.500-6.500 7.500z"/>`),
  affix: wrap(`<path ${SOFT} d="M12 3l2.500 3.500 4.300-.3-.3 4.300L22 13l-3.500 2.500.3 4.300-4.300-.3L12 23l-2.500-3.500-4.300.3.300-4.300L2 13l3.500-2.500-.3-4.300 4.300.3z" transform="translate(0 -1)"/><circle cx="12" cy="12" r="2.200"/>`),
  xp: wrap(`<path ${SOFT} d="M12 3l8 4.500v9L12 21l-8-4.500v-9z"/><path d="M8.500 14.500l3.500-5 3.500 5M12 9.500v7"/>`),
  crown: wrap(CROWN),
  chevron: wrap('<path d="M9 5.500l6.500 6.500L9 18.500"/>'),
  minus: wrap('<path d="M5 12h14"/>'),

  // ---- emblem (logo): a grave arch holding a glimmer crystal
  emblem:
    '<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 58V27C12 15 20.5 6 32 6s20 9 20 21v31z" fill="#11151f" stroke="#e9c46a" stroke-width="2.6"/>' +
    '<path d="M18 58V28c0-9 6-16 14-16s14 7 14 16v30" stroke="#9a7230" stroke-width="1.4"/>' +
    '<path d="M32 19l9 13-9 15-9-15z" fill="#45e0c0" fill-opacity="0.9" stroke="#b4fff0" stroke-width="1.6"/>' +
    '<path d="M23 32h18M32 19l-3.5 13L32 47l3.5-15z" stroke="#0f6a5c" stroke-width="1.2"/>' +
    '<path d="M6 58h52" stroke="#e9c46a" stroke-width="2.6"/></svg>',
} as const;

export type IconName = keyof typeof ICONS;
