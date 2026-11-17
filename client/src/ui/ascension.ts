/**
 * Ascension tab: endless ranks for seven stats (shared/data/meta.ts PARAGON), open after the first won run.
 * Shows the total bonus a stat gives now, what the next rank adds, its price, and where returns diminish.
 */
import { PARAGON, PARAGON_TUNING, type ParagonDef } from '@shared/data/meta.ts';
import { ascensionUnlocked, nextParagonCost, paragonRank, purchaseParagon, state } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr, setText, show, toggle } from './dom.ts';
import type { IconName } from './icons.ts';
import { formatInt, t } from './i18n.ts';
import { UI_CONFIG } from './store.ts';
import { paragonBody, paragonName } from './text.ts';
import type { View } from './view.ts';

const PARAGON_ICON: Record<string, IconName> = {
  asc_might: 'sword', asc_vitality: 'heart', asc_haste: 'hourglass', asc_precision: 'eye', asc_resonance: 'resonance',
  asc_fortune: 'glimmer', asc_wisdom: 'xp',
};

interface Row {
  def: ParagonDef;
  el: HTMLElement;
  rank: HTMLElement;
  total: HTMLElement;
  gain: HTMLElement;
  soft: HTMLElement;
  meter: HTMLElement;
  buy: HTMLButtonElement;
  price: HTMLElement;
  reason: HTMLElement;
}

export function createAscension(): View {
  const rows: Row[] = [];
  const list = h('div', { class: 'gg-asc-list' });
  const totalRanks = h('span', { class: 'gg-asc-total gg-num' });

  for (const def of PARAGON) {
    const rank = h('b', { class: 'gg-asc-rank gg-num' });
    const total = h('span', { class: 'gg-asc-now' });
    const gain = h('b', { class: 'gg-num' });
    const soft = h('em', { class: 'gg-asc-soft', title: t('asc.soft', { n: PARAGON_TUNING.SOFT_RANK }) }, t('asc.softTag'));
    const meter = h('i', { class: 'gg-asc-meter-fill' });
    const price = h('span', { class: 'gg-meta-price gg-num' });
    const reason = h('span', { class: 'gg-meta-reason' });
    const buy = h('button', {
      class: 'gg-btn gg-cut gg-btn--glimmer gg-meta-buy', type: 'button', 'data-testid': `ascension-buy-${def.id}`, 'data-sfx': 'buy',
      onClick: () => {
        if (!purchaseParagon(def.id)) return;
        retrigger(el, 'is-bought');
        window.setTimeout(() => el.classList.remove('is-bought'), UI_CONFIG.PURCHASE_FLASH_MS);
      },
    }, h('span', null, t('asc.buy')), price);
    const el = h('article', { class: 'gg-asc-row gg-cut', 'data-id': def.id, 'data-rank': '0' },
      h('span', { class: 'gg-meta-icon' }, icon(PARAGON_ICON[def.id] ?? 'ascension')),
      h('div', { class: 'gg-asc-main' },
        h('div', { class: 'gg-asc-top' }, h('h3', null, paragonName(def)), rank, soft),
        total,
        h('div', { class: 'gg-asc-meter', title: t('asc.soft', { n: PARAGON_TUNING.SOFT_RANK }) }, meter),
      ),
      h('div', { class: 'gg-asc-next' }, h('span', null, t('asc.next')), gain),
      h('div', { class: 'gg-meta-shop' }, buy, reason),
    );
    rows.push({ def, el, rank, total, gain, soft, meter, buy, price, reason });
    list.append(el);
  }

  const locked = h('div', { class: 'gg-asc-locked gg-cut', 'data-testid': 'ascension-locked' },
    h('span', { class: 'gg-asc-locked-icon' }, icon('lock')),
    h('div', null, h('h3', null, t('asc.locked.title')), h('p', null, t('asc.locked.body'))),
  );
  const preview = h('div', { class: 'gg-label gg-asc-preview' }, t('asc.locked.preview'));
  const intro = h('p', { class: 'gg-hub-intro' }, icon('ascension'), h('span', null, t('asc.intro')), totalRanks);
  const el = h('div', { class: 'gg-hub-pane gg-hub-ascension', 'data-testid': 'ascension-root', 'data-unlocked': 'false' },
    locked, intro, preview, list,
    h('footer', { class: 'gg-page-foot' }, h('p', null, icon('tip'), t('asc.soft', { n: PARAGON_TUNING.SOFT_RANK }))),
  );

  const sync = (): void => {
    const open = ascensionUnlocked();
    const glimmer = Math.max(0, Math.floor(state.profile.glimmer));
    setAttr(el, 'data-unlocked', String(open));
    show(locked, !open);
    show(preview, !open);
    show(intro, open);
    let sum = 0;
    for (const row of rows) {
      const rank = paragonRank(row.def.id);
      sum += rank;
      const cost = nextParagonCost(row.def.id);
      const maxed = cost === null;
      const short = maxed ? 0 : Math.max(0, cost - glimmer);
      setAttr(row.el, 'data-rank', String(rank));
      setText(row.rank, t('common.rank', { n: formatInt(rank) }));
      setText(row.total, rank > 0 ? `${t('asc.total')}: ${paragonBody(row.def, rank)}` : `${t('asc.total')}: –`);
      // The total after the next rank: past the soft rank the step visibly shrinks.
      setText(row.gain, maxed ? '–' : paragonBody(row.def, rank + 1).replace(/\.$/, ''));
      show(row.soft, rank >= PARAGON_TUNING.SOFT_RANK);
      row.meter.style.setProperty('--w', `${Math.min(100, (rank / PARAGON_TUNING.SOFT_RANK) * 100)}%`);
      toggle(row.el, 'is-soft', rank >= PARAGON_TUNING.SOFT_RANK);
      toggle(row.el, 'is-affordable', open && !maxed && short === 0);
      toggle(row.el, 'is-locked', !open);
      row.buy.disabled = !open || maxed || short > 0;
      row.price.replaceChildren(...(maxed ? [icon('check')] : [icon('glimmer'), formatInt(cost)]));
      setText(row.reason, !open || maxed || short === 0 ? '' : t('armory.need', { n: formatInt(short) }));
    }
    setText(totalRanks, t('asc.totalRanks', { n: formatInt(sum) }));
  };

  return { el, sync };
}
