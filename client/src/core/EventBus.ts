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
  'ui:create': { name: string; cls: ClassId };
  'ui:join': { code: string; name: string; cls: ClassId };
  'ui:lobby': { cls?: ClassId; ready?: boolean; oath?: number };
  'ui:start': undefined;
  'ui:pick': { index: number };
  'ui:toLobby': undefined;
  /** Leave the session and return to the main menu. */
  'ui:leave': undefined;
  /** The pause / settings overlay opened or closed (the online game keeps running). */
  'ui:overlay': { open: boolean };
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
  /** HUD-relevant values changed (emitted at most once per snapshot). */
  'state:hud': undefined;

  // ---- Gameplay
  /** Every authoritative gameplay event from the server, in order. */
  'game:event': GameEvent;
  /** Instant local feedback for the own hero's inputs, before the server confirms. */
  'game:localAction': { action: 'primary' | 'secondary' | 'dash' | 'denied' };

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
