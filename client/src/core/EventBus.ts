/**
 * Typed pub/sub. ALL communication between client modules (net, game, render, ui, audio) goes through
 * this bus or through GameState — modules never call each other directly.
 * Event names use `domain:action`.
 */
import type { ClassId, GameEvent, RunPhase } from '@shared/types.ts';
import type { ErrorCode } from '@shared/protocol.ts';
import type { Settings } from './Settings.ts';

export type ConnError = ErrorCode | 'unreachable' | 'connection_lost';

export interface EventMap {
  // ---- UI intents (emitted by ui/, handled by net/ or game/)
  /** `tutorial: true` starts the solo training session instead of a lobby. */
  'ui:create': { name: string; cls: ClassId; tutorial?: boolean };
  'ui:join': { code: string; name: string; cls: ClassId };
  'ui:lobby': { cls?: ClassId; ready?: boolean; oath?: number };
  'ui:start': undefined;
  /** `replace`: keystone draft with full slots — the held keystone to give up. */
  'ui:pick': { index: number; replace?: string };
  /** Spend a draft reroll (state.draftRerolls > 0). */
  'ui:reroll': undefined;
  /** Look or permanent upgrades changed (emitted by core/GameState helpers); net/ resends the loadout in a lobby. */
  'ui:loadout': undefined;
  'ui:toLobby': undefined;
  /** Leave the session and return to the main menu. */
  'ui:leave': undefined;
  /** The pause / settings overlay opened or closed (the online game keeps running). */
  'ui:overlay': { open: boolean };
  /**
   * Ask the 3D view to present a hero of this class (with the profile's look for it) while no chamber is
   * shown — used by the wardrobe / class picker. `screenX` is the horizontal screen position (0..1) the hero
   * should be centred on, so the UI can keep that area free. null hides the showcase.
   */
  'ui:showcase': { cls: ClassId; screenX: number } | null;
  /**
   * Localised words the 3D view draws into the world (it has no access to the UI's texts). Emitted by ui/ at
   * start and whenever the language changes. `reactions` is keyed by ReactionId (data/reactions.ts).
   */
  'ui:labels': { resonance: string; reactions: Record<string, string> };
  /** First user gesture happened — audio may start. */
  'ui:gesture': undefined;

  // ---- Assets
  'assets:progress': { loaded: number; total: number };
  'assets:ready': undefined;
  'assets:error': { message: string };

  // ---- Network / state (emitted by net/ after it has updated GameState)
  'net:status': undefined;
  'net:error': { error: ConnError; fatal: boolean };
  'state:screen': undefined;
  'state:roster': undefined;
  'state:run': { previousPhase: RunPhase | null };
  'state:draft': undefined;
  /** state.profile changed (Glimmer, upgrades, looks, record). */
  'state:profile': undefined;
  /** HUD-relevant values changed (emitted at most once per snapshot). */
  'state:hud': undefined;

  // ---- Gameplay
  /** Every authoritative gameplay event from the server, in order. */
  'game:event': GameEvent;
  /** Instant local feedback for the own hero's inputs, before the server confirms. */
  /** `slot` names the ability a `denied` press was meant for. */
  'game:localAction': { action: 'primary' | 'secondary' | 'dash' | 'ultimate' | 'denied'; slot?: 'secondary' | 'dash' | 'ultimate' };
  /**
   * The own profile gained something outside a purchase: emitted once per finished run after the rewards
   * were booked (levels gained, new relic ranks, feats that became claimable), for toasts and fanfares.
   */
  'game:progress': { cls: ClassId; xp: number; levelsGained: number; level: number; relics: { id: string; rank: number; rankUp: boolean }[]; featsReady: number };

  // ---- Settings
  'settings:changed': Settings;
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

class EventBus {
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof EventMap>(event: K, ...payload: EventMap[K] extends undefined ? [] : [EventMap[K]]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: unknown) => void)(payload[0]);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" failed`, err);
      }
    }
  }
}

export const bus = new EventBus();
