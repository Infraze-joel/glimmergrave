/** Lasting ground effects of hero abilities (shapes `zone` and `trap`) and delayed hostile explosions. */
import { TICK_DT, WORLD } from '../constants.ts';
import { TRAP, ULTIMATE, type AbilityDef } from '../data/classes.ts';
import type { AbilitySlot } from '../types.ts';
import { damageHero, healHero, isTargetable, reviveHero, strikeEnemy } from './combat.ts';
import { KEYSTONE_CAPS } from '../data/keystones.ts';
import { blastEnemies } from './horde.ts';
import { maelstromPull } from './keystones.ts';
import type { Hero, PendingBlast, Zone } from './state.ts';
import { SIM } from './tuning.ts';
import type { World } from './world.ts';

function endZone(w: World, zone: Zone, sprung: boolean): void {
  if (zone.dead) return;
  zone.dead = true;
  w.emit({ e: 'zoneEnd', id: zone.id, x: zone.x, z: zone.z, sprung });
}

/**
 * Creates the zone of `def` for hero `h`. The first pulse comes on its first tick, the following ones every `tick`
 * seconds (duration / tick in all). `arm` > 0 makes it a trap that waits that long before it can go off. */
export function spawnZone(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, x: number, z: number, arm: number): Zone {
  const zone: Zone = {
    id: w.nextZoneId++, def, owner: h.slot, slot, x, z, r: def.radius, time: def.duration + arm, timer: TICK_DT, arm, dead: false,
    follow: def.special === 'follow',
  };
  if (def.shape !== 'trap') {
    // A hero keeps at most ZONES_PER_HERO lasting zones (Blood Price could stack them without end): the oldest ends.
    let own = 0;
    for (const o of w.zones) if (!o.dead && o.owner === h.slot && o.def.shape !== 'trap') own++;
    for (const o of w.zones) {
      if (own < KEYSTONE_CAPS.ZONES_PER_HERO) break;
      if (o.dead || o.owner !== h.slot || o.def.shape === 'trap') continue;
      endZone(w, o, false);
      own--;
    }
  }
  if (w.nextZoneId > 0xffff) w.nextZoneId = 1;
  if (def.shape === 'trap' && def.special === 'max3') {
    // Only TRAP.MAX_ACTIVE traps of one hero lie at once: the oldest gives way.
    let own = 0;
    for (const o of w.zones) if (!o.dead && o.owner === h.slot && o.def.shape === 'trap') own++;
    for (const o of w.zones) {
      if (own < TRAP.MAX_ACTIVE) break;
      if (o.dead || o.owner !== h.slot || o.def.shape !== 'trap') continue;
      endZone(w, o, false);
      own--;
    }
  }
  w.zones.push(zone);
  const inf = h.stats.infusion[slot];
  w.emit({ e: 'zone', id: zone.id, kind: def.id, x, z, r: zone.r, dur: zone.time, el: inf ? inf.element : null, by: h.slot });
  return zone;
}

const inside = (zone: Zone, x: number, z: number, pad: number): boolean => {
  const dx = x - zone.x;
  const dz = z - zone.z;
  const reach = zone.r + pad;
  return dx * dx + dz * dz <= reach * reach;
};

/** Is this downed hero lying in a sanctuary that will still raise it? (Such a party is not defeated yet.) */
export function sanctuaryHolds(w: World, h: Hero): boolean {
  for (const zone of w.zones) {
    if (zone.dead || zone.def.special !== 'revive' || !inside(zone, h.body.x, h.body.z, 0)) continue;
    if (zone.time >= ULTIMATE.SANCTUARY_REVIVE_SECONDS - h.sanctuary) return true;
  }
  return false;
}

function pulse(w: World, zone: Zone, owner: Hero): void {
  const def = zone.def;
  if (def.special === 'maelstrom') maelstromPull(w, zone.x, zone.z, zone.r, Math.max(def.tick, TICK_DT));
  if (def.damage > 0) {
    const before = owner.run.damage;
    for (const e of w.enemies) {
      if (!isTargetable(e) || !inside(zone, e.x, e.z, e.radius)) continue;
      strikeEnemy(w, owner, e, def.damage, zone.slot, { fromX: zone.x, fromZ: zone.z, stun: def.stun, knockback: def.knockback });
    }
    // The maelstrom a Skullsplitter leaves is Maelstrom's own damage (counted for the soaks; its hits stay direct).
    if (def.special === 'maelstrom') owner.ks.dealt.ks_barbarian = (owner.ks.dealt.ks_barbarian ?? 0) + owner.run.damage - before;
  }
  if (def.heal > 0) {
    const amount = def.heal * (zone.slot === 'ultimate' ? 1 + owner.stats.crescendo : 1);
    // Hallowed ground: a hero with the Sanguine Pact gets nothing from it (not even from their own).
    for (const ally of w.heroes) if (inside(zone, ally.body.x, ally.body.z, 0)) healHero(w, ally, amount, true);
  }
}

function stepTrap(w: World, zone: Zone, owner: Hero): void {
  if (zone.arm > 0) {
    zone.arm -= TICK_DT;
    return;
  }
  let tripped = false;
  for (const e of w.enemies) {
    if (!isTargetable(e)) continue;
    const dx = e.x - zone.x;
    const dz = e.z - zone.z;
    const reach = SIM.TRAP_TRIGGER_RADIUS + e.radius;
    if (dx * dx + dz * dz <= reach * reach) { tripped = true; break; }
  }
  if (!tripped) return;
  const def = zone.def;
  const inf = owner.stats.infusion[zone.slot];
  w.emit({ e: 'aoe', x: zone.x, z: zone.z, r: zone.r, el: inf ? inf.element : null, hostile: false });
  for (const e of w.enemies) {
    if (!isTargetable(e) || !inside(zone, e.x, e.z, e.radius)) continue;
    strikeEnemy(w, owner, e, def.damage, zone.slot, { fromX: zone.x, fromZ: zone.z, stun: def.stun, knockback: def.knockback });
  }
  endZone(w, zone, true);
}

export function stepZones(w: World): void {
  const dt = TICK_DT;
  const zones = w.zones;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i] as Zone;
    if (zone.dead) continue;
    const owner = w.hero(zone.owner);
    if (!owner) { endZone(w, zone, false); continue; }
    zone.time -= dt;
    if (zone.follow && owner.state === 'alive') {
      zone.x = owner.body.x;
      zone.z = owner.body.z;
    }
    if (zone.def.shape === 'trap') {
      stepTrap(w, zone, owner);
    } else {
      if (zone.def.special === 'smoke') {
        for (const e of w.enemies) if (isTargetable(e) && inside(zone, e.x, e.z, e.radius)) e.smokeTime = SIM.SMOKE_LINGER;
      } else if (zone.def.special === 'revive') {
        for (const d of w.heroes) {
          if (d.state !== 'downed' || !inside(zone, d.body.x, d.body.z, 0)) continue;
          d.sanctuary += dt;
          if (d.sanctuary < ULTIMATE.SANCTUARY_REVIVE_SECONDS - SIM.EPS) continue;
          if (d !== owner) owner.run.revives++;
          reviveHero(w, d, owner.slot, WORLD.REVIVE_HP_FRACTION * (1 + owner.stats.lifeline), SIM.REVIVE_IFRAMES);
        }
      }
      zone.timer -= dt;
      if (zone.timer <= SIM.EPS) {
        zone.timer += Math.max(zone.def.tick, dt);
        pulse(w, zone, owner);
      }
    }
    // A zone that has run out simply stops (clients remove it after `dur`); only early ends are announced.
    if (zone.time <= SIM.EPS) zone.dead = true;
  }
  let keep = 0;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i] as Zone;
    if (!zone.dead) zones[keep++] = zone;
  }
  zones.length = keep;
}

/** Removes every zone at once (chamber cleared / left); each is announced so clients can drop the visuals. */
export function clearZones(w: World): void {
  for (const zone of w.zones) endZone(w, zone, false);
  w.zones.length = 0;
  w.blasts.length = 0;
  w.trails.length = 0;
  w.blooms.length = 0;
}

/**
 * Delayed hostile explosions (volatile affix, a slain bomber): announced when queued, they hurt heroes inside when
 * they go off; a bomber's also tears through the horde.
 */
export function stepBlasts(w: World): void {
  const blasts = w.blasts;
  let keep = 0;
  for (let i = 0; i < blasts.length; i++) {
    const b = blasts[i] as PendingBlast;
    b.t -= TICK_DT;
    if (b.t > SIM.EPS) { blasts[keep++] = b; continue; }
    w.emit({ e: 'aoe', x: b.x, z: b.z, r: b.r, el: null, hostile: true });
    for (const h of w.heroes) {
      const dx = h.body.x - b.x;
      const dz = h.body.z - b.z;
      if (dx * dx + dz * dz <= b.r * b.r) damageHero(w, h, b.damage, -1);
    }
    if (b.enemyDamage > 0) blastEnemies(w, b.x, b.z, b.r, b.enemyDamage);
  }
  blasts.length = keep;
}
