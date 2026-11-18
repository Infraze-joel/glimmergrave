/**
 * Codex: the rules of the game in one place, reachable from the main menu and the pause menu.
 * Every number is read from the shared balance tables at render time, never copied.
 */
import { RUN, WORLD, depthScale } from '@shared/constants.ts';
import { BOONS, SETS, type BoonCategory } from '@shared/data/boons.ts';
import { CLASSES, DASH, ULTIMATE } from '@shared/data/classes.ts';
import { FEATS } from '@shared/data/feats.ts';
import { MASTERY, XP_REWARDS } from '@shared/data/mastery.ts';
import { PARAGON, PARAGON_TUNING } from '@shared/data/meta.ts';
import { REACTIONS } from '@shared/data/reactions.ts';
import { RELICS, RELIC_TUNING } from '@shared/data/relics.ts';
import * as enemyData from '@shared/data/enemies.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { HAZARD_TIMING } from '@shared/sim/hazards.ts';
import { OBJECTIVES, OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { AFFIX_IDS, BOSS_KINDS, CLASS_IDS, DOOR_TYPES, ELEMENT_IDS, OBJECTIVE_KINDS, type EnemyKind, type Hazard, type ObjectiveKind } from '@shared/types.ts';
import { h, icon } from './dom.ts';
import { enemyHealth, enemyName, highlight, phaseThresholds, resonanceParams, statusParams } from './elements.ts';
import { setIcon, setTint } from './hud3.ts';
import { BOSS_ICON } from './hud.ts';
import type { IconName } from './icons.ts';
import { DOOR_TEXT_PARAMS, formatBoon, formatInt, formatNum, roman, t, type I18nKey, type Params } from './i18n.ts';
import { ABILITY_ICON, ART_ICON, CLASS_DIFFICULTY, HERO_SLOTS, MAX_OATH, abilityDesc, abilityName, artDesc, artName, oathDescription, oathName } from './model.ts';
import { affixBody, affixName, modText, paragonName, reactionBody, reactionName, setCounts, setName, setTierText } from './text.ts';
import { boonIcon, boonTint } from './model.ts';
import { pageHead } from './pages.ts';
import { richEl } from './rich.ts';
import { ui, type CodexTab } from './store.ts';
import { FOE_ICON, NEW_FOES, foeParams } from './tips.ts';
import { OBJECTIVE_ICON, hasBonus, objectiveBonus, objectiveGoal, objectiveName } from './objective.ts';
import type { View } from './view.ts';

const PERCENT = 100;
const TABS: readonly CodexTab[] = ['elements', 'classes', 'combat', 'objectives', 'hazards', 'bestiary', 'doors', 'boons', 'progress'];
const TAB_ICON: Record<CodexTab, IconName> = {
  elements: 'element', classes: 'users', combat: 'combat', objectives: 'hunt', hazards: 'spikes', bestiary: 'skull', doors: 'door', boons: 'boon',
  progress: 'ascension',
};
const HAZARD_KINDS: readonly Hazard['kind'][] = ['spikes', 'vent', 'frost'];
const FOES: readonly EnemyKind[] = ['minion', 'warrior', 'archer', 'mage'];
const ENEMY_ICON: Partial<Record<EnemyKind, IconName>> = { minion: 'skull', warrior: 'defense', archer: 'crossbow', mage: 'nova', ...FOE_ICON, ...BOSS_ICON };
const CATEGORIES: readonly BoonCategory[] = ['infusion', 'offense', 'defense', 'mobility', 'element', 'resonance', 'kinship', 'ultimate', 'class', 'duo'];
/** Oath levels listed one by one; the endless ones above follow a rule that one sentence explains. */
const NAMED_OATHS = RUN.OATH.length - 1;
const pctMore = (mul: number): number => Math.round((mul - 1) * PERCENT);

interface HazardNumbers {
  damage: number;
  tick: number;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  (typeof value === 'object' && value !== null ? value as Record<string, unknown> : null);
/** Optional balance tables are looked up by name, so the codex keeps working while they are still being added. */
const optionalTable = (owner: unknown, name: string): Record<string, unknown> | null => record(record(owner)?.[name]);

/** Damage numbers of a hazard from the shared table (data/enemies.ts HAZARD), or null if it has no such row. */
function hazardNumbers(kind: Hazard['kind']): HazardNumbers | null {
  const row = optionalTable(optionalTable(enemyData, 'HAZARD'), kind.toUpperCase());
  const damage = num(row?.DAMAGE);
  const tick = num(row?.TICK);
  return damage !== null && tick !== null ? { damage, tick } : null;
}

function hazardEnemyMul(): number | null {
  return num(optionalTable(enemyData, 'HAZARD')?.ENEMY_DAMAGE_MUL);
}

function heraldHealthPercent(): number | null {
  const fraction = num(optionalTable(ENEMY_TUNING, 'HERALD')?.HP_FRACTION);
  return fraction !== null ? Math.round(fraction * PERCENT) : null;
}

/** Static, trusted drawing markup (same rule as icons.ts: never user data). */
function drawing(markup: string, cls: string): HTMLElement {
  const el = h('div', { class: `gg-draw ${cls}`, 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 120 80" fill="none" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;
  return el;
}

const HERO = '<circle r="5" fill="#efe8d8" stroke="#06070b" stroke-width="1.5"/>';
const FOE = '<circle r="6.5" fill="#39415a" stroke="#aab2c8" stroke-width="1.5"/><circle cx="-2.2" cy="-1" r="1.1" fill="#06070b"/><circle cx="2.2" cy="-1" r="1.1" fill="#06070b"/>';
const at = (x: number, y: number, body: string): string => `<g transform="translate(${x} ${y})">${body}</g>`;
const ESCAPE = 'stroke="#efe8d8" stroke-width="1.6" stroke-dasharray="3 3"';

const TELEGRAPHS: Record<'circle' | 'arc' | 'line', string> = {
  circle:
    '<circle cx="52" cy="42" r="27" fill="rgba(226,65,79,.16)" stroke="#ff4d5e" stroke-width="1.8"/>' +
    '<circle cx="52" cy="42" r="16" fill="rgba(226,65,79,.42)"/>' +
    `${at(52, 42, HERO)}<path d="M60 42h36" ${ESCAPE}/><path d="M91 37l6 5-6 5" stroke="#efe8d8" stroke-width="1.6"/>`,
  arc:
    '<path d="M60 14L20.2 37A46 46 0 0 0 99.8 37Z" fill="rgba(226,65,79,.16)" stroke="#ff4d5e" stroke-width="1.8"/>' +
    '<path d="M60 14L35.8 28A28 28 0 0 0 84.2 28Z" fill="rgba(226,65,79,.42)"/>' +
    `${at(60, 14, FOE)}${at(60, 46, HERO)}<path d="M60 54v18" ${ESCAPE}/><path d="M55 68l5 6 5-6" stroke="#efe8d8" stroke-width="1.6"/>`,
  line:
    '<rect x="26" y="30" width="88" height="20" fill="rgba(226,65,79,.16)" stroke="#ff4d5e" stroke-width="1.8"/>' +
    '<rect x="26" y="30" width="46" height="20" fill="rgba(226,65,79,.42)"/>' +
    `${at(14, 40, FOE)}${at(84, 40, HERO)}<path d="M84 48v20" ${ESCAPE}/><path d="M79 64l5 6 5-6" stroke="#efe8d8" stroke-width="1.6"/>`,
};

/** Colours as in the 3D view: steel-white spikes, orange vents, cyan frost. */
const HAZARD_COLOR: Record<Hazard['kind'], string> = { spikes: '#dfe6f2', vent: '#ff8a3c', frost: '#58d8ff' };

function hazardDrawing(kind: Hazard['kind'], phase: 'idle' | 'warn' | 'active'): HTMLElement {
  const c = HAZARD_COLOR[kind];
  const floor = '<ellipse cx="60" cy="46" rx="44" ry="24" fill="#141926" stroke="#333b4f" stroke-width="1.5"/>';
  let body: string;
  if (phase === 'idle') {
    body = `<ellipse cx="60" cy="46" rx="30" ry="16" stroke="${c}" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="2 5"/>`;
    if (kind === 'spikes') body += [-16, -5, 6, 17].map((x) => `<circle cx="${60 + x}" cy="46" r="1.6" fill="${c}" fill-opacity=".4"/>`).join('');
    if (kind === 'vent') body += `<ellipse cx="60" cy="46" rx="9" ry="5" fill="#06070b" stroke="${c}" stroke-opacity=".45" stroke-width="1.5"/>`;
    if (kind === 'frost') body += `<path d="M44 46c5-3 9-3 14 0s9 3 16 0" stroke="${c}" stroke-opacity=".4" stroke-width="1.5"/>`;
  } else if (phase === 'warn') {
    body = `<ellipse cx="60" cy="46" rx="30" ry="16" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-width="2" stroke-dasharray="6 4"/>` +
      `<ellipse cx="60" cy="46" rx="17" ry="9" fill="${c}" fill-opacity=".3"/>` +
      `<path d="M60 36v9M60 50v.5" stroke="${c}" stroke-width="3"/>`;
  } else {
    body = `<ellipse cx="60" cy="46" rx="30" ry="16" fill="${c}" fill-opacity=".34" stroke="${c}" stroke-width="2.4"/>`;
    if (kind === 'spikes') {
      body += [-18, -6, 6, 18].map((x) => `<path d="M${56 + x} 48l4-26 4 26z" fill="${c}" stroke="#06070b" stroke-width="1"/>`).join('');
    } else if (kind === 'vent') {
      body += `<path d="M60 10c2 9 14 14 14 27a14 14 0 0 1-28 0c0-6 3-10 6-13 1 4 2 6 5 7-1-8 0-15 3-21z" fill="${c}" stroke="#ffe7ad" stroke-width="1.5"/>` +
        '<path d="M60 48a6 6 0 0 1-6-6c0-3 3-5 6-9 3 4 6 6 6 9a6 6 0 0 1-6 6z" fill="#ffe7ad"/>';
    } else {
      body += [0, 60, 120].map((a) => `<path d="M60 22v32" stroke="${c}" stroke-width="2.4" transform="rotate(${a} 60 38)"/>`).join('') +
        `<path d="M36 52c6-4 10-4 16 0s10 4 16 0 10-4 16 0" stroke="#e8fbff" stroke-width="1.8"/>` +
        `<path d="M42 60c5-3 9-3 14 0s9 3 14 0" stroke="${c}" stroke-width="1.6"/>`;
    }
  }
  return drawing(floor + body, `gg-draw--hazard is-${phase}`);
}

function card(iconName: IconName, title: string, body: string, cls = ''): HTMLElement {
  return h('article', { class: `gg-codex-card gg-cut ${cls}` },
    h('span', { class: 'gg-codex-card-icon' }, icon(iconName)),
    h('div', null, h('h4', null, title), richEl('p', '', body)),
  );
}

const heading = (text: string, iconName?: IconName): HTMLElement =>
  h('h3', { class: 'gg-codex-h' }, iconName ? icon(iconName) : null, text);

// ------------------------------------------------------------------ tabs

function elementsTab(): HTMLElement[] {
  const statuses = h('div', { class: 'gg-codex-statuses' });
  for (const el of ELEMENT_IDS) {
    statuses.append(h('article', { class: 'gg-status-card gg-cut', 'data-element': el },
      h('span', { class: 'gg-status-icon' }, icon(el)),
      h('div', { class: 'gg-status-names' },
        h('b', null, t(`element.${el}.name`)),
        h('span', null, t('codex.elements.applies')),
        h('strong', null, t(`status.${el}.name`)),
      ),
      h('p', null, t(`status.${el}.detail`, statusParams(el))),
    ));
  }
  const foe = (cls: string, label: string | null): HTMLElement =>
    h('span', { class: `gg-res-foe ${cls}` }, icon('skull'), label ? h('i', null, label) : null);
  const step = (n: number, key: 'step1' | 'step2' | 'step3', scene: HTMLElement, params?: Params): HTMLElement =>
    h('li', { class: `gg-res-step gg-res-step--${n}` },
      scene,
      h('div', { class: 'gg-res-text' },
        h('b', null, h('span', { class: 'gg-res-num gg-num' }, String(n)), t(`codex.res.${key}`)),
        h('span', null, t(`codex.res.${key}.desc`, params)),
      ),
    );
  const diagram = h('ol', { class: 'gg-res-diagram' },
    step(1, 'step1', h('div', { class: 'gg-res-scene' }, h('span', { class: 'gg-res-shot is-a' }, icon('ember'), 'A'), icon('arrow', 'gg-res-arrow'), foe('has-a', 'A'))),
    step(2, 'step2', h('div', { class: 'gg-res-scene' }, h('span', { class: 'gg-res-shot is-b' }, icon('rime'), 'B'), icon('arrow', 'gg-res-arrow'), foe('has-a', 'A'))),
    step(3, 'step3', h('div', { class: 'gg-res-scene is-burst' }, foe('has-b is-small', 'B'), foe('is-core', null), foe('has-b is-small', 'B')), resonanceParams()),
  );
  const pairs = h('ul', { class: 'gg-codex-pairs gg-codex-reactions' });
  for (const reaction of REACTIONS) {
    const [a, b] = reaction.pair;
    const row = h('li', { class: 'gg-cut', 'data-reaction': reaction.id },
      h('span', { class: 'gg-reaction-pair' },
        h('span', { class: `gg-el-${a}` }, icon(a), t(`element.${a}.name`)),
        icon('plus', 'gg-pair-plus'),
        h('span', { class: `gg-el-${b}` }, icon(b), t(`element.${b}.name`)),
      ),
      h('b', null, reactionName(reaction)),
      h('span', { class: 'gg-reaction-body' }, reactionBody(reaction)),
      h('em', { class: 'gg-num' }, t('codex.reactions.burst', { dmg: formatNum(reaction.damageMul), r: formatNum(reaction.radiusMul) })),
    );
    row.style.setProperty('--el-a', `var(--gg-${a})`);
    row.style.setProperty('--el-b', `var(--gg-${b})`);
    pairs.append(row);
  }
  return [
    richEl('p', 'gg-codex-intro', t('codex.elements.intro')),
    statuses,
    heading(t('codex.res.title'), 'resonance'),
    richEl('p', 'gg-codex-lead', t('codex.res.lead')),
    diagram,
    richEl('p', 'gg-codex-note', t('codex.res.rule')),
    heading(t('codex.res.pairs6'), 'duo'),
    richEl('p', 'gg-codex-lead', t('codex.reactions.intro')),
    pairs,
  ];
}

function combatTab(): HTMLElement[] {
  const shapes = h('div', { class: 'gg-codex-shapes' });
  for (const shape of ['circle', 'arc', 'line'] as const) {
    shapes.append(h('article', { class: 'gg-shape-card gg-cut' },
      drawing(TELEGRAPHS[shape], 'gg-draw--tele'),
      h('h4', null, t(`codex.tele.${shape}`)),
      h('p', null, t(`codex.tele.${shape}.desc`)),
    ));
  }
  return [
    heading(t('codex.tele.title'), 'warning'),
    richEl('p', 'gg-codex-lead', t('codex.tele.rule')),
    shapes,
    h('div', { class: 'gg-codex-grid' },
      card('dash', t('codex.dash.title'), t('codex.dash.desc', { t: DASH.IFRAMES, cd: DASH.COOLDOWN })),
      card('bash', t('codex.stagger.title'), t('codex.stagger.desc')),
      card('revive', t('codex.revive.title'), t('codex.revive.desc', {
        r: WORLD.REVIVE_RADIUS, t: WORLD.REVIVE_SECONDS, hp: Math.round(WORLD.REVIVE_HP_FRACTION * PERCENT),
      })),
      card('heart', t('codex.wind.title'), t('codex.wind.desc', { n: RUN.SOLO_SECOND_WINDS })),
    ),
  ];
}

function hazardsTab(): HTMLElement[] {
  const enemyMul = hazardEnemyMul();
  const rows = h('div', { class: 'gg-codex-hazards' });
  const phases: ['idle' | 'warn' | 'active', Params][] = [['idle', {}], ['warn', { t: HAZARD_TIMING.WARN }], ['active', {}]];
  for (const kind of HAZARD_KINDS) {
    const strip = h('div', { class: 'gg-hazard-phases' });
    phases.forEach(([phase, params], index) => {
      if (index > 0) strip.append(icon('arrow', 'gg-hazard-arrow'));
      strip.append(h('figure', { class: `gg-hazard-phase is-${phase}` },
        hazardDrawing(kind, phase),
        h('figcaption', null, h('b', null, t(`hazard.phase.${phase}`)), h('span', null, t(`hazard.phase.${phase}Desc`, params))),
      ));
    });
    const numbers = hazardNumbers(kind);
    const row = h('article', { class: 'gg-hazard-row gg-cut', 'data-hazard': kind },
      h('div', { class: 'gg-hazard-info' },
        h('span', { class: 'gg-hazard-icon' }, icon(kind)),
        h('h4', null, t(`hazard.${kind}.name`)),
        richEl('p', '', t(`hazard.${kind}.desc`, { t: HAZARD_TIMING.ACTIVE[kind] })),
        numbers ? h('p', { class: 'gg-hazard-numbers gg-num' }, t('codex.hazards.damage', { dmg: numbers.damage, tick: numbers.tick })) : null,
      ),
      strip,
    );
    row.style.setProperty('--hz', HAZARD_COLOR[kind]);
    rows.append(row);
  }
  return [
    richEl('p', 'gg-codex-intro', t('codex.hazards.intro')),
    h('p', { class: 'gg-codex-note' }, enemyMul !== null
      ? t('codex.hazards.cycle', { warn: HAZARD_TIMING.WARN, mul: enemyMul })
      : t('codex.hazards.cycleShort', { warn: HAZARD_TIMING.WARN })),
    rows,
  ];
}

function enemyTipParams(kind: EnemyKind): Params {
  if (kind === 'warrior') return { n: ENEMY_TUNING.WARRIOR_SHIELD_HP };
  if (kind === 'champion') return { n: ENEMY_TUNING.CHAMPION.SUMMON_EVERY };
  if (kind === 'regent') {
    const [a, b] = phaseThresholds({ kind, name: '', herald: false });
    return { a: Math.round((a ?? 0) * PERCENT), b: Math.round((b ?? 0) * PERCENT) };
  }
  return foeParams(kind);
}

/** First chamber (1-based) an enemy kind may appear in, or null when it is there from the start. */
function firstChamber(kind: EnemyKind): number | null {
  const def = (enemyData.ENEMIES as Partial<typeof enemyData.ENEMIES>)[kind];
  return def && def.minChamber > 0 ? def.minChamber + 1 : null;
}

function enemyCard(kind: EnemyKind): HTMLElement {
  const hp = enemyHealth(kind);
  const boss = (BOSS_KINDS as readonly string[]).includes(kind);
  const from = boss || kind === 'champion' ? null : firstChamber(kind);
  return h('article', { class: `gg-enemy-card gg-cut${boss ? ' is-boss' : kind === 'champion' ? ' is-elite' : ''}`, 'data-enemy': kind },
    h('span', { class: 'gg-enemy-icon' }, icon(ENEMY_ICON[kind] ?? 'skull')),
    h('div', { class: 'gg-enemy-main' },
      h('div', { class: 'gg-enemy-top' },
        h('h4', null, enemyName(kind)),
        from !== null ? h('span', { class: 'gg-enemy-from gg-num' }, t('codex.bestiary.from', { n: from })) : null,
        hp !== null ? h('span', { class: 'gg-enemy-hp gg-num' }, icon('heart'), t('codex.enemies.health', { n: formatInt(hp) })) : null,
      ),
      h('p', null, t(`enemy.${kind}.desc` as I18nKey, enemyTipParams(kind))),
      h('p', { class: 'gg-enemy-tip' }, h('b', null, t('codex.enemies.beat')), ' ', t(`enemy.${kind}.tip` as I18nKey, enemyTipParams(kind))),
    ),
  );
}

function bestiaryTab(): HTMLElement[] {
  const heraldHp = heraldHealthPercent();
  const heraldNote = heraldHp !== null ? [h('p', { class: 'gg-codex-note' }, t('enemy.herald.desc', { hp: heraldHp }))] : [];
  const foes = h('div', { class: 'gg-codex-enemies', 'data-group': 'core' });
  for (const kind of FOES) foes.append(enemyCard(kind));
  const special = h('div', { class: 'gg-codex-enemies', 'data-group': 'special' });
  for (const kind of NEW_FOES) special.append(enemyCard(kind));
  const bosses = h('div', { class: 'gg-codex-enemies', 'data-group': 'bosses' });
  bosses.append(enemyCard('champion'));
  for (const kind of BOSS_KINDS) bosses.append(enemyCard(kind));
  return [
    richEl('p', 'gg-codex-intro', t('codex.bestiary.intro')),
    heading(t('codex.bestiary.core'), 'skull'),
    foes,
    heading(t('codex.bestiary.special'), 'warning'),
    special,
    h('p', { class: 'gg-codex-note' }, t('codex.bestiary.rule')),
    h('div', { class: 'gg-codex-grid gg-codex-grid--wide' },
      card('warded', t('codex.bestiary.ward.title'), t('codex.bestiary.ward.body', { n: ENEMY_TUNING.WARD.FROM_CHAMBER + 1 }), 'gg-codex-ward'),
      card('elite', t('chamber.elite'), t('codex.enemies.elite', {
        hp: pctMore(ENEMY_TUNING.ELITE_HP_MUL), dmg: pctMore(ENEMY_TUNING.ELITE_DAMAGE_MUL),
      })),
    ),
    heading(t('codex.enemies.bosses'), 'boss'),
    h('p', { class: 'gg-codex-lead' }, t('codex.enemies.final')),
    bosses,
    ...heraldNote,
  ];
}

/** Numbers quoted in the "how it works" text of an objective, from OBJECTIVE_TUNING. */
function objectiveParams(kind: ObjectiveKind): Params {
  const tune = OBJECTIVE_TUNING;
  switch (kind) {
    case 'survive': return { a: tune.SURVIVE.SECONDS, b: tune.SURVIVE.MAX_SECONDS };
    case 'defend': return { share: Math.round(tune.DEFEND.ATTACKER_SHARE * PERCENT), r: formatNum(tune.DEFEND.REPAIR_RADIUS) };
    case 'hunt':
      return { n: tune.HUNT.TARGETS, t: tune.HUNT.SECONDS, dmg: pctMore(tune.HUNT.ENRAGE_DAMAGE_MUL), spd: pctMore(tune.HUNT.ENRAGE_SPEED_MUL) };
    case 'ritual': return { n: tune.RITUAL.SITES, t: formatNum(tune.RITUAL.SECONDS_TO_LIGHT), x: Math.round(tune.RITUAL.EXTRA_HERO_SPEED * PERCENT) };
    case 'vault':
      return { hp: Math.round(tune.VAULT.HEAL_FRACTION * PERCENT), n: tune.VAULT.EXTRA_CHOICES, max: tune.MAX_VAULTS_PER_DEPTH };
    default: return {};
  }
}

function objectivesTab(): HTMLElement[] {
  const cards = h('div', { class: 'gg-codex-objectives' });
  for (const kind of OBJECTIVE_KINDS) {
    const from = OBJECTIVES[kind].minChamber > 0 ? OBJECTIVES[kind].minChamber + 1 : null;
    cards.append(h('article', { class: 'gg-objective-card gg-cut', 'data-objective': kind, 'data-testid': `codex-objective-${kind}` },
      h('span', { class: 'gg-objective-icon' }, icon(OBJECTIVE_ICON[kind])),
      h('div', { class: 'gg-objective-main' },
        h('div', { class: 'gg-objective-top' },
          h('h4', null, objectiveName(kind)),
          from !== null ? h('span', { class: 'gg-enemy-from gg-num' }, t('codex.bestiary.from', { n: from })) : null,
        ),
        h('p', { class: 'gg-objective-goal' }, objectiveGoal(kind)),
        h('p', null, t(`objective.${kind}.detail`, objectiveParams(kind))),
        hasBonus(kind)
          ? h('p', { class: 'gg-objective-bonus' }, icon('star'), h('b', null, `${t('objective.bonus')}:`), ' ',
            kind === 'ritual' ? `${objectiveBonus(kind)} (${OBJECTIVE_TUNING.RITUAL.BONUS_SECONDS} s)` : objectiveBonus(kind))
          : h('p', { class: 'gg-objective-bonus is-none' }, t('codex.objectives.noBonus')),
      ),
    ));
  }
  return [
    richEl('p', 'gg-codex-intro', t('codex.objectives.intro')),
    cards,
    h('div', { class: 'gg-codex-grid gg-codex-grid--wide' },
      card('star', t('codex.objectives.bonus.title'), t('codex.objectives.bonus.body', { n: OBJECTIVE_TUNING.BONUS_EXTRA_CHOICES, g: OBJECTIVE_TUNING.BONUS_GLIMMER }), 'gg-codex-bonus'),
      card('door', t('codex.doors.title'), t('codex.objectives.doors')),
    ),
  ];
}

function doorsTab(): HTMLElement[] {
  const doors = h('div', { class: 'gg-codex-grid' });
  for (const type of DOOR_TYPES) {
    const desc = type === 'boss' ? t('codex.doors.boss')
      : type === 'descend' ? t('codex.doors.descend') : type === 'ascend' ? t('codex.doors.ascend') : t(`door.${type}.desc`, DOOR_TEXT_PARAMS);
    doors.append(card(type, t(`door.${type}.name`), desc, `gg-door--${type}`));
  }
  const oaths = h('ol', { class: 'gg-codex-oaths' });
  for (let level = 0; level <= NAMED_OATHS; level++) {
    oaths.append(h('li', { class: 'gg-cut' },
      h('b', { class: 'gg-oath-num' }, roman(level)),
      h('div', null, h('strong', null, oathName(level)), h('span', null, oathDescription(level))),
    ));
  }
  return [
    heading(t('codex.doors.title'), 'door'),
    h('p', { class: 'gg-codex-lead' }, t('codex.doors.intro', { t: WORLD.DOOR_HOLD_SECONDS })),
    doors,
    heading(t('codex.oath.title'), 'bell'),
    h('p', { class: 'gg-codex-lead' }, t('codex.oath.intro', { n: Math.round(REWARDS.OATH_BONUS * PERCENT) })),
    oaths,
    h('p', { class: 'gg-codex-note' }, t('codex.oath.more', {
      max: roman(MAX_OATH), n: roman(NAMED_OATHS), hp: Math.round(RUN.OATH_HP_STEP * PERCENT), dmg: Math.round(RUN.OATH_DAMAGE_STEP * PERCENT),
    })),
    heading(t('codex.glimmer.title'), 'glimmer'),
    h('p', { class: 'gg-codex-lead' }, t('codex.glimmer.intro')),
    h('p', { class: 'gg-codex-note' }, t('armory.earnHint', {
      c: REWARDS.PER_CHAMBER_CLEARED, e: REWARDS.PER_ELITE_SLAIN, b: REWARDS.BOSS_SLAIN, m: REWARDS.MINIMUM,
    })),
  ];
}

function boonRow(iconName: IconName, tint: string, rarity: string, name: string, desc: string, levels: number): HTMLElement {
  const text = h('span', { class: 'gg-codex-boon-desc' });
  text.append(...highlight(desc));
  const row = h('li', { class: `gg-codex-boon gg-rarity-${rarity}` },
    h('span', { class: 'gg-codex-boon-icon' }, icon(iconName)),
    h('b', null, name),
    h('em', null, `${t(`rarity.${rarity}` as I18nKey)} · ${t('codex.boons.levels', { n: levels })}`),
    text,
  );
  row.style.setProperty('--tint', tint);
  return row;
}

function boonsTab(): HTMLElement[] {
  const out: HTMLElement[] = [h('p', { class: 'gg-codex-intro' }, t('codex.boons.intro'))];
  for (const category of CATEGORIES) {
    const list = h('ul', { class: 'gg-codex-boons' });
    if (category === 'infusion') {
      for (const el of ELEMENT_IDS) {
        const def = BOONS.find((b) => b.category === 'infusion' && b.element === el);
        list.append(boonRow(el, `var(--gg-${el})`, def?.rarity ?? 'rare',
          t('codex.boons.infusionAny', { element: t(`element.${el}.name`) }),
          t('codex.boons.infusionDesc', { status: t(`status.${el}.name`), detail: t(`status.${el}.detail`, statusParams(el)) }),
          def?.values.length ?? 1));
      }
    } else {
      for (const def of BOONS) {
        if (def.category !== category) continue;
        const text = formatBoon(def.id, 1);
        list.append(boonRow(boonIcon(def), boonTint(def), def.rarity, text.name, text.desc, def.values.length));
      }
    }
    out.push(
      h('section', { class: 'gg-codex-cat', 'data-category': category },
        h('header', null, heading(t(`category.${category}`), category), h('p', null, t(`codex.cat.${category}`))),
        list,
      ),
    );
  }
  out.push(...setsSection());
  return out;
}

function setsSection(): HTMLElement[] {
  const list = h('ul', { class: 'gg-codex-sets' });
  for (const def of SETS) {
    const row = h('li', { class: 'gg-cut', 'data-set': def.id },
      h('span', { class: 'gg-codex-set-icon' }, icon(setIcon(def))),
      h('div', { class: 'gg-codex-set-id' }, h('b', null, setName(def)), h('span', null, setCounts(def))),
      h('div', { class: 'gg-codex-set-tier' }, h('em', { class: 'gg-num' }, `${roman(1)} · ${t('codex.sets.need', { n: def.need[0] })}`), h('span', null, setTierText(def, 1))),
      h('div', { class: 'gg-codex-set-tier' }, h('em', { class: 'gg-num' }, `${roman(2)} · ${t('codex.sets.need', { n: def.need[1] })}`), h('span', null, setTierText(def, 2))),
    );
    row.style.setProperty('--tint', setTint(def));
    list.append(row);
  }
  return [
    h('section', { class: 'gg-codex-cat', 'data-category': 'sets' },
      h('header', null, heading(t('codex.sets.title'), 'gem'), richEl('p', '', t('codex.sets.intro'))),
      list,
    ),
    h('section', { class: 'gg-codex-cat', 'data-category': 'duo-note' },
      h('header', null, heading(t('codex.duo.title'), 'duo'), h('p', null, t('codex.duo.body')))),
  ];
}

function classesTab(): HTMLElement[] {
  const list = h('div', { class: 'gg-codex-classes' });
  for (const cls of CLASS_IDS) {
    const def = CLASSES[cls];
    const rows = h('ul', { class: 'gg-class-abilities' });
    const line = (slotLabel: string, iconName: IconName, name: string, desc: string, cssClass = ''): HTMLElement =>
      h('li', { class: cssClass }, h('em', { class: 'gg-codex-slot' }, slotLabel), icon(iconName, 'gg-class-ability-icon'),
        h('span', { class: 'gg-class-ability-text' }, h('b', null, name), ' ', h('span', null, desc)));
    for (const slot of HERO_SLOTS) {
      rows.append(line(t(`slot.${slot}`), ABILITY_ICON[cls][slot], abilityName(cls, slot), abilityDesc(cls, slot), `is-${slot}`));
      if (slot === 'secondary' && def.arts.length > 0) rows.append(line(t('slot.art'), ART_ICON[cls], artName(cls), artDesc(cls), 'is-art'));
    }
    list.append(h('article', { class: `gg-codex-class gg-cut gg-cls-${cls}`, 'data-cls': cls },
      h('header', null,
        h('span', { class: 'gg-class-emblem' }, icon(cls)),
        h('div', null,
          h('h4', null, t(`class.${cls}.name`)),
          h('p', null, t(`class.${cls}.role`), ' · ', t(`difficulty.${CLASS_DIFFICULTY[cls]}`)),
        ),
        h('span', { class: 'gg-codex-class-stats gg-num' }, t('codex.classes.stats', { hp: def.maxHp, speed: formatNum(def.moveSpeed), dash: def.dashCharges })),
      ),
      rows,
    ));
  }
  return [
    richEl('p', 'gg-codex-intro', t('codex.classes.intro', { n: MASTERY.ART_LEVEL })),
    list,
    heading(t('codex.ult.title'), 'ultimate'),
    richEl('p', 'gg-codex-lead', t('codex.ult.body', { max: ULTIMATE.MAX })),
  ];
}

function progressTab(): HTMLElement[] {
  const deep = depthScale(1);
  const affixes = h('div', { class: 'gg-codex-grid' });
  for (const id of AFFIX_IDS) affixes.append(card('affix', affixName(id), affixBody(id), 'gg-codex-affix'));
  const [t1, t2, t3] = MASTERY.TALENT_LEVELS;
  return [
    heading(t('codex.descent.title'), 'descend'),
    richEl('p', 'gg-codex-lead', t('codex.descent.body', { heal: Math.round(RUN.DEPTH.HEAL_FRACTION * PERCENT), n: RUN.CHAMBERS.length })),
    h('p', { class: 'gg-codex-note' }, t('codex.descent.scale', {
      hp: pctMore(deep.hp), dmg: pctMore(deep.damage), reward: Math.round(XP_REWARDS.DEPTH_BONUS * PERCENT),
    })),
    heading(t('codex.affix.title'), 'affix'),
    h('p', { class: 'gg-codex-lead' }, t('codex.affix.intro', { d: roman(RUN.DEPTH.AFFIX_FROM_DEPTH + 1), o: roman(RUN.DEPTH.AFFIX_FROM_OATH) })),
    affixes,
    h('div', { class: 'gg-codex-grid gg-codex-grid--wide' },
      card('mastery', t('codex.mastery.title'), `${t('codex.mastery.body', { art: MASTERY.ART_LEVEL, t1, t2, t3 })} ${t('mastery.perLevel', { bonus: modText(MASTERY.PER_LEVEL) })}`),
      card('relic', t('codex.relics.title'), t('codex.relics.body', {
        n: RELICS.length, max: RELIC_TUNING.MAX_RANK, step: Math.round(RELIC_TUNING.RANK_STEP * PERCENT), a: RELIC_TUNING.BASE_SLOTS, b: RELIC_TUNING.MAX_SLOTS,
      })),
      card('ascension', t('codex.ascension.title'), `${t('codex.ascension.body', { n: PARAGON_TUNING.SOFT_RANK })} ${PARAGON.map(paragonName).join(' · ')}.`),
      card('chronicle', t('codex.chronicle.title'), t('codex.chronicle.body', { n: FEATS.length })),
    ),
  ];
}

const BUILDERS: Record<CodexTab, () => HTMLElement[]> = {
  elements: elementsTab, classes: classesTab, combat: combatTab, objectives: objectivesTab, hazards: hazardsTab, bestiary: bestiaryTab, doors: doorsTab,
  boons: boonsTab,
  progress: progressTab,
};

export function createCodex(close: () => void): View {
  const body = h('div', { class: 'gg-codex-body', tabindex: 0 });
  const buttons = new Map<CodexTab, HTMLButtonElement>();
  const tabs = h('nav', { class: 'gg-codex-tabs', role: 'tablist', 'aria-label': t('codex.title') });
  let shown: CodexTab | null = null;

  const sync = (): void => {
    const tab = TABS.includes(ui.codexTab) ? ui.codexTab : 'elements';
    for (const [id, btn] of buttons) {
      btn.classList.toggle('is-selected', id === tab);
      btn.setAttribute('aria-selected', String(id === tab));
    }
    if (shown === tab) return;
    shown = tab;
    body.dataset.tab = tab;
    body.replaceChildren(...BUILDERS[tab]());
    body.scrollTop = 0;
  };

  for (const tab of TABS) {
    const btn = h('button', {
      class: 'gg-codex-tab', type: 'button', role: 'tab', 'data-testid': `codex-tab-${tab}`, 'data-sfx': 'tab',
      onClick: () => { ui.codexTab = tab; sync(); },
    }, icon(TAB_ICON[tab]), h('span', null, t(`codex.tab.${tab}`)));
    buttons.set(tab, btn);
    tabs.append(btn);
  }

  const el = h('section', { class: 'gg-page gg-codex gg-backdrop', 'data-testid': 'codex-root' },
    h('div', { class: 'gg-page-layout' },
      pageHead({ icon: 'codex', title: t('codex.title'), close }),
      tabs,
      body,
    ),
  );
  return { el, sync };
}
