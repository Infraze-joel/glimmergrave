/** Simulation-only tuning (anything both sides must agree on lives in ../constants.ts and ../data/*). */
export const SIM = {
  /** Queued inputs per hero; the oldest is dropped on overflow. */
  INPUT_BUFFER_MAX: 4,
  /** A button press is remembered this long if the ability cannot start right away. */
  PRESS_BUFFER_SECONDS: 0.15,
  /** Timer comparisons tolerate float drift of the fixed timestep. */
  EPS: 1e-6,
  MAX_AIM_DIST: 25,
  /** Temporary shields (knight bash) fade after this long. */
  TEMP_SHIELD_SECONDS: 5,
  REVIVE_DECAY_PER_SECOND: 0.5,
  REVIVE_IFRAMES: 1.5,
  SECOND_WIND_DELAY: 1.2,
  SECOND_WIND_IFRAMES: 2.5,
  /** Oathbond's own-health trigger re-arms above this health fraction. */
  OATHBOND_HP_THRESHOLD: 0.3,
  /** Dash infusion: enemies within this distance of the dash path are struck once per dash. */
  DASH_INFUSION_RADIUS: 1.5,
  DASH_INFUSION_DAMAGE: 8,
  KNOCKBACK_SPEED: 14,
  BURN_TICK_SECONDS: 0.5,
  /** Bosses are immune to stun and knockback and resist chill. */
  BOSS_CHILL_FACTOR: 0.4,
  CORPSE_SECONDS: 0.6,
  /** Interrupted (poise broken) enemies are staggered this long and restart part of their cooldown. */
  STAGGER_SECONDS: 0.35,
  STAGGER_COOLDOWN_FRACTION: 0.5,
  /** Half angle (degrees) of the warrior's frontal shield. */
  SHIELD_HALF_ARC_DEG: 65,
  ACTION_ANIM_MIN_SECONDS: 0.25,
  HIT_ANIM_SECONDS: 0.2,
  /** Input magnitude above which a hero plays its run animation. */
  RUN_ANIM_THRESHOLD: 0.1,
} as const;

export const AI = {
  RETARGET_SECONDS: 1.2,
  /** A new target must be this much closer (fraction) to steal aggro. */
  STICKINESS: 0.75,
  SEPARATION_PAD: 0.35,
  SEPARATION_WEIGHT: 1.6,
  AVOID_PAD: 0.6,
  /** Obstacle avoidance: look-ahead distance and strength of the sideways push. */
  AVOID_LOOKAHEAD: 4, AVOID_PUSH: 1.2, AVOID_PUSH_MIN: 0.6, AVOID_SIDE_EPSILON: 0.05,
  /** How far a melee telegraph reaches beyond the distance at which the attack starts. */
  MINION_REACH_BONUS: 0.7,
  WARRIOR_REACH_BONUS: 0.8,
  /** Melee enemies stop this fraction of their attack range away from the target. */
  MELEE_STOP_FRACTION: 0.8,
  /** Post-attack recovery during which the enemy stands still. */
  RECOVER_SECONDS: 0.4,
  /** At most this many enemies wind up a melee attack against the same hero at once. */
  MAX_MELEE_WINDUPS_PER_HERO: 3,
  FIRST_ATTACK_DELAY_MIN: 0.2,
  FIRST_ATTACK_DELAY_MAX: 0.9,
  ARROW_RANGE: 18,
  ARROW_RADIUS: 0.25,
  ARROW_TELEGRAPH_WIDTH: 0.9,
  ARCHER_BAND: 1.5,
  ARCHER_STRAFE_SECONDS: 2.2,
  /** Ranged positioning: step length of a reposition target, strafe speed factor, wall margin, "did I move" factors. */
  KITE_STEP: 3, STRAFE_SPEED_FACTOR: 0.5, KITE_WALL_MARGIN: 0.2, STUCK_FACTOR: 0.2, MOVING_FACTOR: 0.15,
  MAGE_KEEP_DISTANCE: 8.5,
  MAGE_BAND: 1.5,
  MAGE_BLINK_TRIGGER: 3.6,
  MAGE_BLINK_MIN_HERO_DISTANCE: 4.5,
  /** Blink directions tried in order, relative to "straight away from the hero" (degrees). */
  MAGE_BLINK_ANGLES: [0, 40, -40, 80, -80, 120, -120, 180],
  MAGE_BLINK_WALL_MARGIN: 1, MAGE_BLINK_OBSTACLE_MARGIN: 0.3, MAGE_BLINK_RETRY_SECONDS: 1,
  ORB_RADIUS: 0.35,
  ORB_RANGE: 26,
  CHAMPION: {
    SWEEP_RECOVER: 0.7, CHARGE_RECOVER: 1.1, CHARGE_COOLDOWN: 7, CHARGE_MIN_DISTANCE: 5,
    SUMMON_CAST: 0.9, SUMMON_RECOVER: 0.5, FIRST_SUMMON: 8, CHASE_PATIENCE: 3.5,
  },
  REGENT: {
    SWEEP_RECOVER: 0.8, CHARGE_RECOVER: 1.3, CHARGE_COOLDOWN: 8, CHARGE_MIN_DISTANCE: 5.5,
    VOLLEY_COOLDOWN: 7, VOLLEY_TELEGRAPH_RADIUS: 3, VOLLEY_WAVE_INTERVAL: 0.55, VOLLEY_RECOVER: 0.8,
    SUMMON_CAST: 1.0, SUMMON_RECOVER: 0.6,
    SLAM_COOLDOWN: 9, SLAM_RECOVER: 1.0,
    PHASE_PAUSE: 1.2, PHASE2_CADENCE: 0.8, PHASE3_CADENCE: 0.7, MIN_GAP: 0.75, CHASE_PATIENCE: 3,
    RETARGET_SECONDS: 6,
  },
  /** Bosses: first-attack delays, minimum lane length for a charge, chance to pick a non-nearest target. */
  BOSS_FIRST_GAP: 1, BOSS_FIRST_CHARGE: 3, BOSS_FIRST_VOLLEY: 4, CHARGE_MIN_LANE: 3, BOSS_RANDOM_TARGET_CHANCE: 0.35,
  REGENT_CLOSE_VOLLEY_CHANCE: 0.35,
  SUMMON_RING_MIN: 2.2,
  SUMMON_RING_MAX: 4,
} as const;

export const DIRECTOR = {
  ROOM_W_MIN: 26, ROOM_W_MAX: 38, ROOM_D_MIN: 20, ROOM_D_MAX: 28,
  BOSS_ROOM_W: 40, BOSS_ROOM_D: 30,
  OBSTACLES_MIN: 4, OBSTACLES_MAX: 10, BOSS_OBSTACLES: 4,
  /** Minimum free space between obstacle surfaces, walls and spawn points. */
  OBSTACLE_GAP: 3, WALL_CLEARANCE: 3, SPAWN_CLEARANCE: 4, DOOR_CLEARANCE: 4.5,
  SPAWN_WALL_OFFSET: 2.5, SPAWN_SPACING: 2.2,
  DOOR_WALL_OFFSET: 1.6,
  /** Enemies never rise closer than this to a hero (falls back to the farthest free spot in tiny rooms). */
  ENEMY_SPAWN_MIN_DISTANCE: 7,
  ENEMY_WALL_MARGIN: 1.5,
  SPAWN_SAMPLES: 24,
  OBSTACLE_ATTEMPTS: 400,
  FIRST_WAVE_DELAY: 1.5,
  WAVE_DELAY: 1.2,
  SPAWN_STAGGER: 0.15,
  /** The next wave starts when at most this many enemies are alive, or after WAVE_TIMEOUT. */
  NEXT_WAVE_ALIVE: 2,
  WAVE_TIMEOUT: 28,
  /** Wave budget = (BASE + PER_CHAMBER * chamber) * party scaling. */
  BUDGET_BASE: 12, BUDGET_PER_CHAMBER: 2.0,
  WAVES_EARLY: 3, WAVES_LATE: 4, WAVES_LATE_FROM_CHAMBER: 2,
  ELITE_WAVES: 2, ELITE_ESCORT_BUDGET: 0.45, ELITE_REINFORCE_BUDGET: 0.6,
  KIND_WEIGHT: { minion: 5, warrior: 2.2, archer: 2.2, mage: 1.4 },
  /** Caps on simultaneously spawned ranged enemies per wave: base + per hero. */
  ARCHER_CAP_BASE: 2, ARCHER_CAP_PER_HERO: 1, MAGE_CAP_BASE: 1, MAGE_CAP_PER_HERO: 0.5,
  /** Extra enemy damage per additional hero (parties share the pressure and can revive each other). */
  DAMAGE_PER_EXTRA_PLAYER: 0.05,
  CLEAR_DELAY: 0.8,
  /** Room generation details. */
  OBSTACLE_GRID: 0.25, CENTRED_OBSTACLE_CHANCE: 0.2, BOSS_PILLAR_INSET: 3, BOSS_PILLAR_RADIUS: 0.9,
  ENEMY_OBSTACLE_MARGIN: 0.4, SPAWN_GRID_STEP: 1,
} as const;
