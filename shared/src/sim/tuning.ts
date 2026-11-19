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
  /** Damage dealt to a hero's `fragile` projectile target counts as destroyed within this extra reach. */
  WISP_HIT_PAD: 0.1,
  // ---- update 3
  /** Shields granted at the start of a chamber (warding, talents, relics) last the whole chamber. */
  START_SHIELD_SECONDS: 3600,
  /** Extra projectiles of an ability without a spread of its own (mage_split) fan out by this much each. */
  SPLIT_SPREAD_DEG: 8,
  /** A trap goes off when an enemy's edge comes this close to its centre. */
  TRAP_TRIGGER_RADIUS: 0.8,
  /** Smoke keeps working this long after an enemy was last inside it. */
  SMOKE_LINGER: 0.2,
  SHADOW_DAGGER_SPEED: 32, SHADOW_DAGGER_RADIUS: 0.4, SHADOW_DAGGER_RANGE_PAD: 4,
  /** Statuses that jump (set special `spread`, chain_reaction, ember heart) look this far for the next enemy. */
  SPREAD_RANGE: 8,
  /** Buff ultimates with an infusion mark every enemy within this distance when cast. */
  BUFF_PULSE_RADIUS: 6,
  /** Arcane Echo: delay of the repeated volley. */
  ECHO_DELAY: 0.1,
  /** Chill, Wither and other cuts never reduce an enemy's speed or damage by more than this. */
  MAX_CUT: 0.9,
  /** A warded enemy announces a nullified element (`warded` event) at most once per this many seconds. */
  WARDED_EVENT_SECONDS: 1,
  /** Bosses are held by Shatter for this long (they cannot be stunned). */
  BOSS_STAGGER_SECONDS: 0.35,
} as const;

/** Talent specials (data/mastery.ts names them; the numbers of their texts live here). */
export const TALENT = {
  RIPOSTE_MULTIPLIER: 2,
  RAMPAGE_ATTACK_SPEED: 0.04, RAMPAGE_SECONDS: 4, RAMPAGE_MAX_STACKS: 5,
  ARCANE_ECHO_EVERY: 4,
  /** Poison Tips: potency of the Wither (0.5 = half the normal duration). */
  POISON_POTENCY: 0.5,
  MARTYR_SHARE: 0.2,
  SPELLWEAVE_DAMAGE: 1, SPELLWEAVE_PIERCE: 2,
} as const;

/** Elite affixes (AFFIX_IDS in types.ts). */
export const AFFIX = {
  SWIFT_SPEED: 1.3, SWIFT_ATTACK_RATE: 1.3,
  ARMORED_REDUCTION: 0.4,
  VOLATILE_RADIUS: 2.6, VOLATILE_DELAY: 0.9, VOLATILE_DAMAGE: 14,
  /** Fraction of its maximum health a vampiric elite regains per hit on a hero. */
  VAMPIRIC_HEAL: 0.08,
} as const;

/** Permanent upgrades (values themselves live in data/meta.ts). */
export const META = {
  /** Seconds of invulnerability a hero with `resolve` gets when revived. */
  RESOLVE_INVULNERABILITY: 2,
  /** Choices of the attunement draft at run start. */
  ATTUNEMENT_CHOICES: 3,
  /** Tenacity: extra solo Second Winds and how much faster its owner is revived in a party. */
  TENACITY_SECOND_WINDS: 1, TENACITY_REVIVE: 0.5,
} as const;

export const AI = {
  /** Veil of Knives: enemies that lost a shade walk to where it vanished and stop this far from the spot. */
  VEIL_SEARCH_STOP: 1,
  /** ...and when they find a hero again they need this long (drawn per enemy) before their next attack, so a pack does not strike as one. */
  VEIL_REACQUIRE_MIN: 0.5, VEIL_REACQUIRE_MAX: 1.4,
  // ---- update 4: the five new kinds (numbers both sides must know live in ENEMY_TUNING).
  // SHAMAN.MAX_MENDS: an enemy can be mended this often in its life, so healing never outlasts a weak party.
  SHAMAN: { BAND: 1.5, BOLT_TELEGRAPH_WIDTH: 0.8, BOLT_RANGE: 16, FIRST_MEND: 2.5, MEND_APPROACH: 0.8, MEND_SOON: 1.5, MAX_MENDS: 2 },
  AEGIS: { ARC_DEG: 100, REACH_BONUS: 0.7 },
  BOMBER: { RETARGET_SECONDS: 3 },
  NECROMANCER: { BAND: 1.5, FIRST_RAISE: 2, RING_MIN: 1.4, RING_MAX: 2.6 },
  REAVER: { ARC_DEG: 90, REACH_BONUS: 0.7, FIRST_LEAP: 1, LEAP_RECOVER: 0.35, FOCUS_SECONDS: 5, WALL_MARGIN: 0.8 },
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
  MATRON: {
    KEEP_BAND: 2, MIN_GAP: 0.75, PHASE_PAUSE: 1.2, PHASE2_CADENCE: 0.85, PHASE3_CADENCE: 0.7,
    RING_RECOVER: 0.9, RING_WAVE_INTERVAL: 0.6, RING_TELEGRAPH_RADIUS: 2.5, RING_COOLDOWN: 3.5,
    SPIRAL_RECOVER: 1.2, SPIRAL_COOLDOWN: 12,
    BEAM_RECOVER: 1.3, BEAM_COOLDOWN: 11, FIRST_BEAM: 9,
    BLAST_RECOVER: 1.0, BLAST_COOLDOWN: 8, FIRST_BLAST: 3.5,
    WISP_RECOVER: 0.8, WISP_COOLDOWN: 12, FIRST_WISP: 6, WISP_SPAWN_OFFSET: 1.4,
    SUMMON_CAST: 1.0, SUMMON_RECOVER: 0.8,
    BLINK_MIN_HERO_DISTANCE: 5, BLINK_RETRY_SECONDS: 1.5, BLINK_GAP: 0.5,
    /** A blast circle for another hero is only added when it keeps this much free space to every other circle. */
    BLAST_MIN_GAP: 1.4,
  },
  STALKER: {
    KEEP_BAND: 2, MIN_GAP: 0.7, PHASE_PAUSE: 1.0, PHASE2_CADENCE: 0.85, PHASE3_CADENCE: 0.7,
    FAN_RECOVER: 0.8, FAN_TELEGRAPH_WIDTH: 0.9, FAN_COOLDOWN: 2.5,
    SPEAR_RECOVER: 1.1, SPEAR_COOLDOWN: 9, FIRST_SPEAR: 4.5,
    LEAP_RECOVER: 1.2, LEAP_COOLDOWN: 9, FIRST_LEAP: 6, LEAP_POUNCE_MIN_DISTANCE: 7, LEAP_POUNCE_CHANCE: 0.5,
    LEAP_WALL_MARGIN: 1.5, LEAP_MIN_HERO_DISTANCE: 5.5,
    TRAP_CAST: 0.5, TRAP_RECOVER: 0.6, TRAP_COOLDOWN: 13, FIRST_TRAP: 8, TRAP_SCATTER: 3.5, TRAP_MIN_GAP: 1,
    FRENZY_RECOVER: 2.2, FRENZY_COOLDOWN: 15,
  },
  /** Hazards: enemies steer around warning / active hazards with this much extra clearance. */
  HAZARD_PAD: 0.5, HAZARD_PUSH: 1.4,
  /** Bosses: first-attack delays, minimum lane length for a charge, chance to pick a non-nearest target. */
  BOSS_FIRST_GAP: 1, BOSS_FIRST_CHARGE: 3, BOSS_FIRST_VOLLEY: 4, CHARGE_MIN_LANE: 3, BOSS_RANDOM_TARGET_CHANCE: 0.35,
  REGENT_CLOSE_VOLLEY_CHANCE: 0.35,
  SUMMON_RING_MIN: 2.2,
  SUMMON_RING_MAX: 4,
} as const;

/**
 * Layout profile of a biome (rooms stay rectangles with circular obstacles):
 *  crypt   – pillared halls: mirrored pillars, columns and clutter; a few spike traps from chamber 1 on
 *  flooded – wide and open, few large obstacles, clusters of frost mist
 *  forge   – long rooms cut into lanes by rows of anvils / stalagmites / braziers, fire vents in the lanes
 */
export const BIOME = {
  crypt: {
    W_MIN: 26, W_MAX: 38, D_MIN: 20, D_MAX: 28, OBSTACLES_MIN: 4, OBSTACLES_MAX: 10,
    HAZARDS_MIN: 2, HAZARDS_MAX: 4, HAZARDS_FROM_CHAMBER: 1, HAZARD_R_MIN: 1.4, HAZARD_R_MAX: 1.9, PERIOD_MIN: 4.5, PERIOD_MAX: 6.5,
  },
  flooded: {
    W_MIN: 34, W_MAX: 42, D_MIN: 24, D_MAX: 30, OBSTACLES_MIN: 2, OBSTACLES_MAX: 5,
    CLUSTERS_MIN: 2, CLUSTERS_MAX: 3, CLUSTER_SIZE_MIN: 2, CLUSTER_SIZE_MAX: 3, CLUSTER_SPREAD: 2.6,
    HAZARD_R_MIN: 1.7, HAZARD_R_MAX: 2.3, PERIOD_MIN: 7, PERIOD_MAX: 9,
  },
  forge: {
    W_MIN: 24, W_MAX: 28, D_MIN: 30, D_MAX: 36, ROWS_MIN: 1, ROWS_MAX: 2, ROW_STEP_MIN: 5, ROW_STEP_MAX: 6.5,
    /** Chance that a slot in a row stays empty (a wider gap between lanes); a row never ends up with fewer than ROW_MIN obstacles if it can help it. */
    ROW_SKIP_CHANCE: 0.25, ROW_MIN: 3,
    HAZARDS_MIN: 3, HAZARDS_MAX: 5, HAZARD_R_MIN: 1.5, HAZARD_R_MAX: 1.9, PERIOD_MIN: 5.5, PERIOD_MAX: 7.5,
  },
  /** Boss arenas: hazards of the biome's kind near the walls. */
  BOSS: { HAZARDS_MIN: 2, HAZARDS_MAX: 4, HAZARD_R: 2, PERIOD_MIN: 6, PERIOD_MAX: 8, EDGE_BAND: 4.5 },
  /** Minimum distance of a hazard's edge to spawn points, to the edge of a door zone, to obstacles, walls and other hazards. */
  HAZARD_SPAWN_CLEARANCE: 4, HAZARD_DOOR_CLEARANCE: 2, HAZARD_OBSTACLE_GAP: 0.4, HAZARD_WALL_GAP: 1.2, HAZARD_GAP: 2.4,
  HAZARD_ATTEMPTS: 200,
  /** No room ever has more hazards than this. */
  MAX_HAZARDS: 8,
  /** Grid step of the walkability check that guarantees a hazard-free route from the spawns to every door. */
  PATH_GRID: 0.5,
  /** Wave composition: weight multipliers per biome (the cost budget is unchanged). */
  KIND_BIAS: {
    crypt: { minion: 1, warrior: 1, archer: 1, mage: 1 },
    flooded: { minion: 0.9, warrior: 0.75, archer: 1.4, mage: 1.35 },
    forge: { minion: 1, warrior: 1.9, archer: 0.8, mage: 0.8 },
  },
  /** Chamber index at which act 2 and act 3 begin (act 1 is always the crypt). */
  ACT_STARTS: [0, 3, 6],
} as const;

export const TUTORIAL = {
  ROOM_W: 26, ROOM_D: 20,
  /** Seconds between finishing a step and the next one starting. */
  STEP_LINGER: 0.9,
  MOVE_MARKER: { x: 0, z: 1.5, r: 1.6 },
  DUMMY_RESPAWN_SECONDS: 1.2,
  ATTACK_DUMMIES: [{ x: -3, z: -2.5 }, { x: 0, z: -4 }, { x: 3, z: -2.5 }], ATTACK_DUMMY_HP: 45,
  /** The training warrior and its slow lane attack (DASH_EVERY = pause between two attacks). */
  DASH_ATTACKER: { x: 0, z: -6.5 }, DASH_WINDUP: 1.5, DASH_EVERY: 2, DASH_FIRST: 1.2, DASH_WIDTH: 3.2, DASH_DAMAGE: 8,
  /** After this many attacks any avoided attack counts, with or without a dash. */
  DASH_FALLBACK_ATTEMPTS: 5,
  GROUP_DUMMIES: [{ x: -1.1, z: -3.6 }, { x: 1.1, z: -3.6 }, { x: 0, z: -5.2 }, { x: 0, z: -2.2 }], GROUP_DUMMY_HP: 320, SECONDARY_HITS: 2,
  ELEMENT_DUMMIES: [{ x: -2.4, z: -3 }, { x: 2.4, z: -3 }], ELEMENT_DUMMY_HP: 420,
  /** After this long in the `storm` step any Resonance counts. */
  STORM_FALLBACK_SECONDS: 30,
  /** The training hazard is almost always warning or active, so a foe that walks across it is certain to be caught. */
  HAZARD: { x: -6, z: 0.5, r: 2.2, period: 2.8 },
  CHASER_OFFSET: 5, CHASER_HP: 400, CHASER_SPEED_MUL: 0.4, CHASER_DAMAGE_MUL: 0.3, HAZARD_MARKER_OFFSET: 4, HAZARD_MARKER_R: 1.3,
  OBSTACLES: [{ x: 9, z: -2.5, r: 0.9 }, { x: 9, z: 3, r: 0.9 }],
} as const;

/** Chamber objectives: what the sim needs beyond OBJECTIVE_TUNING (data/objectives.ts). */
export const OBJECTIVE = {
  /** Survive / ritual: no new group rises while the living enemies cost more than this many regular waves. */
  MAX_ALIVE_BUDGET: 1.1,
  /** Survive / ritual: seconds before the first group. */
  FIRST_SPAWN: 1.5,
  /** Placement of the shard, the braziers and the reliquary: free space to obstacles, hazards, walls, spawns, doors. */
  OBSTACLE_GAP: 1.2, HAZARD_GAP: 0.8, WALL_GAP: 1.5, SPAWN_GAP: 5, DOOR_GAP: 2,
  /** Braziers keep this much free ground between their circles; attempts before the gap is halved. */
  SITE_GAP: 5, PLACE_ATTEMPTS: 120,
  /** The shard and the reliquary stand near the middle of the room: random offset up to this many metres. */
  CENTRE_SCATTER: 3,
  /** Hunt: the marked elites are tougher than ordinary elites; kinds they are drawn from. */
  HUNT_HP_MUL: 3,
  HUNT_KINDS: ['warrior', 'mage', 'reaver', 'archer'],
  /** Defend: kinds that can be sent against the shard (their attacks are areas that can cover it). */
  SIEGE_KINDS: ['minion', 'warrior', 'bomber', 'mage'],
  /** Ritual: a brazier takes this much longer to light per additional hero in the party (SECONDS_TO_LIGHT is the solo time). */
  RITUAL_SECONDS_PER_EXTRA_HERO: 1,
  /** Vault: seconds a living hero has to stand within OBJECTIVE_TUNING.VAULT.OPEN_RADIUS_PAD of the reliquary's edge; its size. */
  VAULT_HOLD_SECONDS: 1.5, VAULT_RADIUS: 0.9,
  /**
   * Polish 1: the fixtures are solid. Collision radius of a brazier's bowl (the shard uses DEFEND.RADIUS, the
   * reliquary VAULT_RADIUS), and how far from a fixture's edge a hero's edge must find walkable ground that is
   * connected to the spawn points and the doors (checked at FIXTURE_APPROACH_POINTS points around it). FIXTURE_LANE:
   * free ground that always stays between a fixture and every obstacle and wall (a hero is 1 m wide).
   */
  RITUAL_BOWL_RADIUS: 0.6, FIXTURE_APPROACH: 0.8, FIXTURE_APPROACH_POINTS: 8, FIXTURE_LANE: 1.2,
} as const;

export const DIRECTOR = {
  ROOM_W_MIN: 26, ROOM_W_MAX: 38, ROOM_D_MIN: 20, ROOM_D_MAX: 28,
  BOSS_ROOM_W: 40, BOSS_ROOM_D: 30,
  OBSTACLES_MIN: 4, OBSTACLES_MAX: 10, BOSS_OBSTACLES: 4,
  /** Escort budget of the herald fight (fraction of a regular wave) and its number of waves. */
  HERALD_ESCORT_BUDGET: 0.3, HERALD_WAVES: 1,
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
  BUDGET_BASE: 15, BUDGET_PER_CHAMBER: 2.1,
  WAVES_EARLY: 3, WAVES_LATE: 4, WAVES_LATE_FROM_CHAMBER: 2,
  ELITE_WAVES: 2, ELITE_ESCORT_BUDGET: 0.45, ELITE_REINFORCE_BUDGET: 0.6,
  KIND_WEIGHT: { minion: 5, warrior: 2.2, archer: 2.2, mage: 1.4, shaman: 0.8, aegis: 0.6, bomber: 1.3, necromancer: 0.6, reaver: 1.1 },
  /** Caps on simultaneously spawned ranged enemies per wave: base + per hero. */
  ARCHER_CAP_BASE: 2, ARCHER_CAP_PER_HERO: 1, MAGE_CAP_BASE: 1, MAGE_CAP_PER_HERO: 0.5,
  /** Update 4, per wave: base + per hero (floored). */
  BOMBER_CAP_BASE: 1, BOMBER_CAP_PER_HERO: 1, REAVER_CAP_BASE: 1, REAVER_CAP_PER_HERO: 0.5,
  /** At most one aegis, one necromancer and one shaman ALIVE per this many heroes (rounded up), counting what already stands. */
  HEROES_PER_AEGIS: 2, HEROES_PER_NECROMANCER: 2, HEROES_PER_SHAMAN: 2,
  /** Support kinds (shaman, aegis, necromancer) never take more than this share of a wave's budget. */
  SUPPORT_BUDGET_SHARE: 0.4,
  /** Extra enemy damage per additional hero (parties share the pressure and can revive each other). */
  DAMAGE_PER_EXTRA_PLAYER: 0.1,
  CLEAR_DELAY: 0.8,
  /** Room generation details. */
  OBSTACLE_GRID: 0.25, CENTRED_OBSTACLE_CHANCE: 0.2, BOSS_PILLAR_INSET: 3, BOSS_PILLAR_RADIUS: 0.9,
  ENEMY_OBSTACLE_MARGIN: 0.4, SPAWN_GRID_STEP: 1,
} as const;

/**
 * Keystones (update 5): what the simulation needs beyond `params` in data/keystones.ts. Limits that protect the
 * simulation live in KEYSTONE_CAPS (data), so tests and clients can read them.
 */
export const KS = {
  /** Phase Walker: the dash counts as "through" an enemy when the hero's body overlaps it by this margin. */
  PHASE_PAD: 0.25,
  /** Ricochet: a bounced projectile flies this far past its new target; the blade a melee hero throws. */
  BOUNCE_PAD: 2, BLADE_DAMAGE: 0.6, BLADE_SPEED: 30, BLADE_RANGE: 9, BLADE_RADIUS: 0.4,
  /** Titan Grip: melee arcs reach this much further (their angle grows by `area`, up to a full circle). */
  HEAVY_REACH: 0.2, FULL_CIRCLE_DEG: 360,
  /** Familiar bolt. */
  FAMILIAR_SPEED: 26, FAMILIAR_RADIUS: 0.35, FAMILIAR_RANGE_PAD: 3,
  /** Maelstrom: enemies within this many whirlwind radii are dragged; never closer to the centre than MIN. */
  PULL_REACH: 2, PULL_MIN: 1.1,
  /** Arc Stream: grace after the last pulse during which the hero still counts as channelling; knockback share per pulse. */
  CHANNEL_GRACE: 0.1, STREAM_KNOCKBACK: 0.25,
  /** Blade Tempest: the two extra waves of the finisher fly this many degrees to either side. */
  TEMPEST_SPREAD_DEG: 14,
  /** Twin Cast: a twinned trap arms after this long. */
  TWIN_TRAP_ARM: 0.2,
  /** Enemy growth that pays for keystones: health / damage multipliers per elite chamber cleared at this depth. */
  ELITE_HP_GROWTH: 0.16, ELITE_DAMAGE_GROWTH: 0.08,
} as const;
