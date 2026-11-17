// TEMPORARY progress-preview harness (lead). Delete before release.
import { bus } from '../core/EventBus.ts';
import { state } from '../core/GameState.ts';
import { initUI } from '../ui/index.ts';

initUI(document.getElementById('ui-root') as HTMLElement);
bus.emit('assets:ready');
state.profile.name = 'Joel';
state.screen = 'menu';
bus.emit('state:screen');
