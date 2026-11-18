import { BOSS_KINDS, CLASS_IDS, type ClassId } from '@shared/types.ts';
import { runBots } from '../harness.ts';
const PARTY = process.argv[3] === 'party';
const seeds = PARTY ? 4 : 12;
const PARTIES: ClassId[][] = process.argv[3] === 'party' ? [['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'], ['templar', 'spellblade', 'shade', 'mage'], ['templar', 'shade', 'spellblade', 'knight']] : CLASS_IDS.map((c) => [c]);
for (const classes of PARTIES) for (const boss of BOSS_KINDS) for (let i = 0; i < seeds; i++) {
  const seed = (i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + classes.length; const cls = classes.join('+');
  let start = 0; let key = ''; let printed = false;
  runBots({ classes, seed, overrides: { finalBoss: boss, objective: process.argv[2] === 'classic' ? 'slay' : undefined }, onTick: (w) => {
    const now = `${w.run.depth}.${w.run.chamber}`;
    if (now !== key) { key = now; start = w.run.elapsed; printed = false; }
    if (!printed && w.run.phase === 'combat' && w.run.elapsed - start > 200 && w.run.chamberKind !== 'boss') {
      printed = true;
      const h = w.heroes[0]!;
      console.info(cls, boss, seed, 'chamber', w.run.chamber, w.run.chamberKind, w.run.objective?.kind, 'wave', w.run.wave, w.run.waveCount, 'hero', h.body.x.toFixed(1), h.body.z.toFixed(1), h.state,
        w.enemies.filter((e) => !e.dead).map((e) => `${e.kind}@${e.x.toFixed(1)},${e.z.toFixed(1)} hp${(e.hp / e.maxHp).toFixed(2)} ${e.anim}${e.summoned ? ' S' : ''}`).join(' | '), 'room', w.room.w, w.room.d, w.room.biome);
    }
  } });
}
