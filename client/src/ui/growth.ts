/**
 * Proof of growth (update 5): how much damage the own hero dealt in every chamber of the run, and when each
 * hero took which keystone. The server only sends running totals (`RunState.stats`), so the totals are sampled
 * here: every `chamberClear` closes a chamber, the difference to the previous sample is that chamber's damage.
 *
 * Works from wherever the client starts watching: a hero who joins (or reloads) mid-run gets a chart that
 * begins with that chamber. The samples of the running session survive a reload in sessionStorage.
 * If the server ever sends per-chamber numbers (`PlayerRunStats.chamberDamage`, see the UI report), they win.
 */
import { RUN } from '@shared/constants.ts';
import type { GameEvent, RunState } from '@shared/types.ts';
import { state } from '../core/GameState.ts';
import { h, icon } from './dom.ts';
import { formatInt, formatNum, roman, t } from './i18n.ts';
import { buildInfo, keystoneIcon, keystoneName } from './keystones.ts';
import { ui, UI_CONFIG } from './store.ts';

const STORE_KEY = 'glimmergrave.growth.v1';
/** A stored chart belongs to the running session when the run clock did not jump back by more than this. */
const CLOCK_SLACK_SECONDS = 2;
const PERCENT = 100;

export interface ChamberSample {
  /** 0-based chamber index within its depth, and the depth. */
  chamber: number;
  depth: number;
  kind: RunState['chamberKind'];
  /** Damage the own hero dealt in this chamber. */
  damage: number;
  /** Seconds the fight took, when the client watched it from the start; null otherwise. */
  seconds: number | null;
  /** The run ended (or the hero joined) inside this chamber. */
  partial: boolean;
}

export interface KeystoneTaken {
  slot: number;
  id: string;
  replaced?: string;
  chamber: number;
  depth: number;
  /** Number of chambers that were sampled when it was taken (the chart draws the marker before that bar). */
  at: number;
}

interface Tracker {
  code: string;
  slot: number;
  samples: ChamberSample[];
  taken: KeystoneTaken[];
  /** Own damage total at the last sample; null until the first look at the run. */
  base: number | null;
  /** The first sample does not start at the first chamber of the run. */
  joinedLate: boolean;
  /** A chamber was cleared and waits for a run state with the final totals. */
  pending: { chamber: number; depth: number; kind: RunState['chamberKind']; seconds: number | null } | null;
  /** Run clock when the current fight started (null when it was not seen starting). */
  fightSince: number | null;
  fightChamber: number;
  /** Run clock and chambers cleared at the last look (to notice a new run). */
  clock: number;
  cleared: number;
  /** The run is over and its last chamber is booked. */
  closed: boolean;
}

const fresh = (): Tracker => ({
  code: '', slot: -1, samples: [], taken: [], base: null, joinedLate: false, pending: null, fightSince: null, fightChamber: -1, clock: 0, cleared: 0,
  closed: false,
});

let tracker: Tracker = fresh();
let restored = false;

function save(): void {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(tracker)); } catch { /* storage unavailable */ }
}

function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<Tracker>;
    if (typeof stored.code !== 'string' || !Array.isArray(stored.samples) || !Array.isArray(stored.taken)) return;
    tracker = { ...fresh(), ...stored, pending: null, fightSince: null };
  } catch { /* corrupt entry: start over */ }
}

export function resetGrowth(): void {
  tracker = fresh();
  restored = true;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

const ownDamage = (run: RunState): number => Math.max(0, run.stats.find((row) => row.slot === state.conn.slot)?.damage ?? 0);
const depthOf = (run: RunState): number => Math.max(0, Math.floor(run.depth ?? 0));

function book(run: RunState, partial: boolean): void {
  const total = ownDamage(run);
  const pending = tracker.pending;
  const damage = Math.max(0, total - (tracker.base ?? total));
  tracker.pending = null;
  tracker.base = total;
  // An unfinished chamber without a single point of damage is not worth a bar.
  if (partial && damage <= 0) return;
  tracker.samples.push({
    chamber: pending?.chamber ?? run.chamber, depth: pending?.depth ?? depthOf(run), kind: pending?.kind ?? run.chamberKind, damage,
    seconds: pending ? pending.seconds : null, partial,
  });
}

/** Call on every run-state change (independent of which screen shows). */
export function trackGrowthRun(): void {
  restore();
  const run = state.run;
  if (!run || run.phase === 'lobby' || run.tutorial) {
    if (tracker.base !== null || tracker.samples.length > 0) resetGrowth();
    return;
  }
  const cleared = Math.max(0, Math.floor(run.chambersCleared ?? 0));
  const sameSession = tracker.code === state.conn.code && tracker.slot === state.conn.slot;
  const wentBack = run.elapsed < tracker.clock - CLOCK_SLACK_SECONDS || cleared < tracker.cleared;
  if (tracker.base !== null && (!sameSession || wentBack)) tracker = fresh();
  if (tracker.base === null) {
    // First look at this run: everything dealt so far is before the chart.
    tracker.code = state.conn.code;
    tracker.slot = state.conn.slot;
    tracker.base = ownDamage(run);
    tracker.joinedLate = cleared > 0 || run.chamber > 0 || depthOf(run) > 0;
    // The first chamber counts as watched from the start when the run has only just begun.
    tracker.fightSince = !tracker.joinedLate && run.phase === 'combat' ? 0 : null;
    tracker.fightChamber = run.chamber;
  }
  tracker.clock = run.elapsed;
  tracker.cleared = cleared;
  const over = run.phase === 'victory' || run.phase === 'defeat';
  if (run.phase === 'combat' && !tracker.pending) {
    if (tracker.fightChamber !== run.chamber || tracker.fightSince === null) {
      // A fight the client sees starting is timed; one it walked into is not.
      tracker.fightSince = tracker.fightChamber !== run.chamber ? run.elapsed : tracker.fightSince;
      tracker.fightChamber = run.chamber;
    }
  }
  // The totals of a cleared chamber are final once the run has moved on to the draft, the doors or the end.
  if (tracker.pending && (run.phase !== 'combat' || run.chamber !== tracker.pending.chamber)) book(run, false);
  if (over && !tracker.closed) {
    // Whatever was dealt after the last cleared chamber belongs to the one the run ended in.
    book(run, true);
    tracker.closed = true;
  }
  if (!over) tracker.closed = false;
  if (over) rememberBuilds();
  save();
}

/** Call for every gameplay event (independent of which screen shows). */
export function trackGrowthEvent(ev: GameEvent): void {
  const run = state.run;
  if (!run || run.tutorial) return;
  if (ev.e === 'chamberClear') {
    if (tracker.base === null) trackGrowthRun();
    const seconds = tracker.fightSince !== null && tracker.fightChamber === run.chamber ? Math.max(1, run.elapsed - tracker.fightSince) : null;
    tracker.pending = { chamber: run.chamber, depth: depthOf(run), kind: run.chamberKind, seconds };
    tracker.fightSince = null;
    if (run.phase !== 'combat') book(run, false);
    save();
  } else if (ev.e === 'keystone') {
    restore();
    tracker.taken = tracker.taken.filter((k) => !(k.slot === ev.slot && (k.id === ev.id || k.id === ev.replaced)));
    tracker.taken.push({
      slot: ev.slot, id: ev.id, replaced: ev.replaced, chamber: run.chamber, depth: depthOf(run),
      at: tracker.samples.length + (tracker.pending ? 1 : 0),
    });
    save();
  }
}

/** When a hero took a keystone, as far as this client saw it. */
export function keystoneTaken(slot: number, id: string): KeystoneTaken | null {
  return tracker.taken.find((k) => k.slot === slot && k.id === id) ?? null;
}

export const whenText = (taken: KeystoneTaken): string => (taken.depth > 0
  ? t('summary.keystone.whenDepth', { d: roman(taken.depth + 1), n: taken.chamber + 1 })
  : t('summary.keystone.when', { n: taken.chamber + 1 }));

/** Remembers how every hero's build ended, for the lobby after the run. */
function rememberBuilds(): void {
  const bySlot = new Map<number, { hero: string; build: string; keystones: string[] }>();
  for (const p of state.roster) {
    const info = buildInfo(p);
    if (info.name !== '') bySlot.set(p.slot, { hero: p.name, build: info.name, keystones: info.keystones });
  }
  if (bySlot.size === 0 && ui.lastBuilds.code === state.conn.code) return; // the roster may already be reset
  ui.lastBuilds = { code: state.conn.code, bySlot };
}

// ------------------------------------------------------------------ the chart

export interface Growth {
  samples: ChamberSample[];
  taken: KeystoneTaken[];
  joinedLate: boolean;
  /** Index of the first finished chamber and of the strongest finished one after it (-1 when there is none). */
  first: number;
  best: number;
  /** best / first, or null when it cannot be told. */
  multiple: number | null;
}

/** Per-chamber damage straight from the server, if it sends it (not part of the contract yet). */
function serverSamples(run: RunState): number[] | null {
  const row = run.stats.find((s) => s.slot === state.conn.slot) as { chamberDamage?: unknown } | undefined;
  const list = row?.chamberDamage;
  return Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'number' && Number.isFinite(n)) ? list as number[] : null;
}

export function growth(): Growth {
  restore();
  const run = state.run;
  let samples = tracker.samples;
  let joinedLate = tracker.joinedLate;
  const server = run ? serverSamples(run) : null;
  if (server && run) {
    const total = RUN.CHAMBERS.length;
    samples = server.map((damage, i) => ({
      chamber: i % total, depth: Math.floor(i / total), kind: RUN.CHAMBERS[i % total], damage: Math.max(0, damage),
      seconds: tracker.samples.find((s) => s.chamber === i % total && s.depth === Math.floor(i / total))?.seconds ?? null,
      partial: i === server.length - 1 && run.phase === 'defeat',
    }));
    joinedLate = false;
  }
  const mine = tracker.taken.filter((k) => k.slot === state.conn.slot);
  const done = samples.map((s, i) => ({ s, i })).filter(({ s }) => !s.partial && s.damage > 0);
  const first = done[0]?.i ?? -1;
  let best = -1;
  for (const { s, i } of done.slice(1)) if (best < 0 || s.damage > samples[best].damage) best = i;
  const multiple = first >= 0 && best >= 0 ? samples[best].damage / samples[first].damage : null;
  return { samples, taken: mine, joinedLate, first, best, multiple };
}

const chamberLabel = (sample: ChamberSample, deep: boolean): string => (deep ? `${roman(sample.depth + 1)}·${sample.chamber + 1}` : String(sample.chamber + 1));
const dps = (sample: ChamberSample): number | null => (sample.seconds !== null && sample.seconds > 0 ? sample.damage / sample.seconds : null);

/** The headline of the chart: how much harder the best chamber hit than the first. */
export function growthHeadline(g: Growth): { text: string; tone: 'grew' | 'flat' | 'none' } {
  const finished = g.samples.filter((s) => !s.partial && s.damage > 0).length;
  if (finished === 0) return { text: t('summary.growth.none'), tone: 'none' };
  if (finished === 1 || g.multiple === null) return { text: t('summary.growth.one'), tone: 'none' };
  if (g.multiple < UI_CONFIG.GROWTH_MIN_MULTIPLE) return { text: t('summary.growth.flat'), tone: 'flat' };
  const x = formatNum(g.multiple);
  const lastDone = g.samples.reduce((at, s, i) => (!s.partial && s.damage > 0 ? i : at), -1);
  if (g.best === lastDone) return { text: t('summary.growth.last', { x }), tone: 'grew' };
  const deep = g.samples.some((s) => s.depth > 0);
  const best = g.samples[g.best];
  const label = deep ? t('summary.keystone.whenDepth', { d: roman(best.depth + 1), n: best.chamber + 1 }) : t('summary.keystone.when', { n: best.chamber + 1 });
  return { text: t('summary.growth.best', { x, label }), tone: 'grew' };
}

/** The run summary's growth panel: headline, one bar per chamber, keystone markers. */
export function growthPanel(): HTMLElement {
  const g = growth();
  const head = growthHeadline(g);
  const deep = g.samples.some((s) => s.depth > 0);
  const max = Math.max(1, ...g.samples.map((s) => s.damage));
  const labelled = g.samples.length <= UI_CONFIG.GROWTH_LABEL_MAX;
  const bars = h('ol', { class: `gg-growth-bars${labelled ? '' : ' is-dense'}`, 'data-count': String(g.samples.length) });
  g.samples.forEach((sample, i) => {
    const took = g.taken.filter((k) => k.at === i);
    const title = `${deep
      ? t('summary.growth.barDepth', { d: roman(sample.depth + 1), n: sample.chamber + 1, v: formatInt(sample.damage) })
      : t('summary.growth.bar', { n: sample.chamber + 1, v: formatInt(sample.damage) })}${sample.partial ? ` (${t('summary.growth.partial')})` : ''}`;
    const fill = h('i', { class: 'gg-growth-fill' });
    fill.style.setProperty('--h', `${Math.max(2, Math.round((sample.damage / max) * PERCENT))}%`);
    bars.append(h('li', {
      class: `gg-growth-bar is-${sample.kind}${i === g.first ? ' is-first' : ''}${i === g.best ? ' is-best' : ''}${sample.partial ? ' is-partial' : ''}${took.length > 0 ? ' has-keystone' : ''}${sample.chamber === 0 && i > 0 ? ' is-depth-start' : ''}`,
      title, 'data-damage': String(Math.round(sample.damage)), 'data-chamber': String(sample.chamber), 'data-depth': String(sample.depth),
    },
      took.length > 0
        ? h('span', { class: 'gg-growth-mark', title: took.map((k) => t('summary.growth.took', { name: keystoneName(k.id) })).join(' · ') },
          ...took.map((k) => icon(keystoneIcon(k.id))))
        : null,
      i === g.first || i === g.best ? h('b', { class: 'gg-growth-value gg-num' }, formatInt(sample.damage)) : null,
      h('span', { class: 'gg-growth-col' }, fill),
      labelled || i === g.first || i === g.best ? h('em', { class: 'gg-growth-label gg-num' }, chamberLabel(sample, deep)) : h('em', { class: 'gg-growth-label' }),
    ));
  });
  // Keystones taken after the last sampled chamber (the run ended in the draft) still get their marker.
  const first = g.first >= 0 ? g.samples[g.first] : null;
  const best = g.best >= 0 ? g.samples[g.best] : null;
  const a = first ? dps(first) : null;
  const b = best ? dps(best) : null;
  const notes: string[] = [];
  if (a !== null && b !== null && head.tone === 'grew') notes.push(t('summary.growth.dps', { a: formatInt(a), b: formatInt(b) }));
  if (g.joinedLate && g.samples.length > 0) notes.push(t('summary.growth.joined', { n: chamberLabel(g.samples[0], deep) }));
  return h('section', {
    class: `gg-growth gg-cut is-${head.tone}`, 'data-testid': 'summary-growth', 'data-chambers': String(g.samples.length),
    'data-multiple': g.multiple !== null ? String(Math.round(g.multiple * PERCENT) / PERCENT) : '', 'data-joined': String(g.joinedLate),
  },
    h('header', { class: 'gg-growth-head' },
      h('span', { class: 'gg-label' }, icon('growth'), t('summary.growth')),
      h('b', { class: 'gg-growth-headline', 'data-testid': 'summary-growth-headline' }, head.text),
      notes.length > 0 ? h('span', { class: 'gg-growth-note' }, notes.join(' · ')) : null,
    ),
    g.samples.length > 0 ? bars : null,
  );
}

/** Test / dev hook: replaces the tracked samples (the UI demo shows runs it never played). */
export function setGrowthForDemo(samples: ChamberSample[], taken: KeystoneTaken[], joinedLate: boolean): void {
  tracker = { ...fresh(), code: state.conn.code, slot: state.conn.slot, samples, taken, joinedLate, base: 0, closed: true, clock: state.run?.elapsed ?? 0, cleared: state.run?.chambersCleared ?? 0 };
  restored = true;
}
