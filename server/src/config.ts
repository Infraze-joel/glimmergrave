/** Server-only tuning. Anything the client must agree on lives in shared/src/constants.ts (NET). */
export const SERVER = {
  DEFAULT_PORT: 8787,
  DEFAULT_MAX_ROOMS: 200,
  /** After a stall the loop simulates at most this many ticks at once, then drops the backlog. */
  MAX_CATCHUP_TICKS: 4,
  /** Snapshots and events are skipped for sockets with more than this many bytes queued. */
  BACKPRESSURE_BYTES: 128 * 1024,
  /** `run` is re-sent every this many ticks during draft and doors (~4x per second). */
  RUN_BROADCAST_TICKS: 8,
  /** Invalid messages tolerated per connection before it is closed. */
  MAX_OFFENCES: 5,
  SWEEP_INTERVAL_MS: 1000,
  /** The tick loop keeps running this long after victory / defeat (cheer, last events), then sleeps. */
  END_LINGER_MS: 5000,
  /** Extra sockets (not yet in a room) allowed on top of MAX_ROOMS * MAX_PLAYERS. */
  SPARE_CONNECTIONS: 64,
  TOKEN_BYTES: 16,
  /** Non-integer numbers in JSON messages are rounded to this many decimals. */
  JSON_DECIMALS: 3,
  ROOM_CODE_ATTEMPTS: 50,
  CLOSE_GOING_AWAY: 1001,
  CLOSE_POLICY: 1008,
  CLOSE_NORMAL: 1000,
  /** Health endpoint; '/ws/health' is the one reachable when hosted under the '/ws/*' prefix (Netlify Server). */
  HEALTH_PATHS: ['/health', '/ws/health'],
  WS_PATHS: ['/', '/ws', '/ws/game'],
} as const;
