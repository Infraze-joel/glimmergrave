/** Shared chrome of the full-screen pages (armory, wardrobe, codex): title bar with a close button. */
import { h, icon } from './dom.ts';
import type { IconName } from './icons.ts';
import { t } from './i18n.ts';

export interface PageHead {
  icon: IconName;
  title: string;
  sub?: string;
  /** Extra element between the title and the close button (wallet, tabs). */
  extra?: HTMLElement | null;
  close(): void;
}

export function pageHead(opts: PageHead): HTMLElement {
  return h('header', { class: 'gg-page-head' },
    h('div', { class: 'gg-page-title' },
      h('span', { class: 'gg-page-icon' }, icon(opts.icon)),
      h('div', null,
        h('h2', null, opts.title),
        opts.sub ? h('p', null, opts.sub) : null,
      ),
    ),
    opts.extra ?? null,
    h('button', {
      class: 'gg-btn gg-cut gg-btn--primary gg-page-close', type: 'button', 'data-testid': 'page-close', 'data-sfx': 'back',
      onClick: opts.close,
    }, icon('check'), t('common.done')),
  );
}
