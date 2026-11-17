/**
 * Global tuning that both client and server must agree on.
 * Balance tables live in ./data/*. Never hardcode these numbers elsewhere.
 */
export const NET = {
  /** Authoritative simulation rate (Hz). The sim always advances by exactly 1 / TICK_HZ. */
  TICK_HZ: 30,
  /** Snapshots are sent every SNAPSHOT_EVERY ticks (30 / 2 = 15 Hz). */
  SNAPSHOT_EVERY: 2,
  /** Clients sample and send input once per sim tick. */
  INPUT_HZ: 30,
  /** Remote entities are rendered this far in the past (ms) and interpolated between snapshots. */
  INTERP_DELAY_MS: 120,
  MAX_PLAYERS: 4,
  ROOM_CODE_LENGTH: 5,
  /** Alphabet without look-alike characters (no 0/O, 1/I/L). */
  ROOM_CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  /** A disconnected player keeps their slot this long and can rejoin with their token. */
  REJOIN_GRACE_MS: 90_000,
  /** An empty room is destroyed after this long. */
  EMPTY_ROOM_TTL_MS: 30_000,
  /** Lobby rooms without any activity are destroyed after this long. */
  IDLE_ROOM_TTL_MS: 30 * 60_000,
  MAX_NAME_LENGTH: 16,
  /** Server drops clients that send more than this many messages per second. */
  MAX_MESSAGES_PER_SECOND: 90,
  MAX_MESSAGE_BYTES: 512,
  PING_INTERVAL_MS: 2000,
  /** No message from a client for this long = treated as disconnected. */
  CLIENT_TIMEOUT_MS: 10_000,
  PROTOCOL_VERSION: 2,
} as const;

export const TICK_DT = 1 / NET.TICK_HZ;

export const WORLD = {
  PLAYER_RADIUS: 0.45,
  /** Positions are quantised to 1 / POS_SCALE metres on the wire. */
  POS_SCALE: 64,
  /** Distance within which a standing ally revives a downed player. */
  REVIVE_RADIUS: 1.8,
  REVIVE_SECONDS: 3,
  REVIVE_HP_FRACTION: 0.4,
  /** All living players must stand in a door zone this long to commit to it. */
  DOOR_HOLD_SECONDS: 1.5,
  DOOR_RADIUS: 2.2,
  /** Seconds of invulnerability after being hit (prevents multi-hit bursts). */
  HIT_IFRAME_SECONDS: 0.35,
  MAX_ENEMIES: 48,
  MAX_PROJECTILES: 96,
} as const;

export const RUN = {
  /** Chamber sequence of one run. The last chamber is always the boss. */
  CHAMBERS: ['combat', 'combat', 'combat', 'elite', 'combat', 'combat', 'elite', 'boss'] as const,
  DRAFT_TIMEOUT_SECONDS: 45,
  DRAFT_CHOICES: 3,
  /** Extra enemy health per additional player (multiplicative). */
  HP_PER_EXTRA_PLAYER: 0.6,
  /** Extra enemy count per additional player (multiplicative). */
  COUNT_PER_EXTRA_PLAYER: 0.4,
  /** Enemy health / damage growth per chamber index. */
  HP_GROWTH_PER_CHAMBER: 0.18,
  DAMAGE_GROWTH_PER_CHAMBER: 0.07,
  /** Oath (difficulty) levels 0..3: enemy hp, enemy damage, enemy speed multipliers. */
  OATH: [
    { hp: 1.0, damage: 1.0, speed: 1.0 },
    { hp: 1.25, damage: 1.2, speed: 1.05 },
    { hp: 1.55, damage: 1.45, speed: 1.1 },
    { hp: 1.9, damage: 1.75, speed: 1.15 },
  ],
  /** Solo players get this many self-revives per run. */
  SOLO_SECOND_WINDS: 1,
} as const;

export type ChamberKind = (typeof RUN.CHAMBERS)[number];
