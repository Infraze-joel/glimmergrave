/**
 * The guided training session (solo, server-run like a normal chamber, cannot be joined).
 * The simulation scripts each step and advances when its goal is met; the client shows the matching
 * explanation (`tutorial.<id>.title` / `.body` in ui/i18n.ts). Order = order of play.
 */
export const TUTORIAL_STEPS = [
  /** Walk into the marked circle. */
  'move',
  /** Destroy the training dummies with the primary attack (mouse aims). */
  'attack',
  /** Dash through a slow, telegraphed attack without being hit. */
  'dash',
  /** Use the secondary ability on a group. */
  'secondary',
  /** The primary is now infused with Ember: set a foe ablaze (Burn = damage over time). */
  'burn',
  /** The secondary is now infused with Rime: hit a BURNING foe with it to trigger Resonance. */
  'resonance',
  /** The dash is now infused with Storm: Shock a foe, then burst it with Ember — any two different elements resonate. */
  'storm',
  /** A floor hazard cycles nearby: lure a foe into it (hazards hurt enemies too). */
  'hazard',
  /** Pick a boon from a draft. */
  'draft',
  /** Walk through the door. */
  'door',
] as const;

export type TutorialStep = (typeof TUTORIAL_STEPS)[number];
