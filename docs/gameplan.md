# Glimmergrave

## Pitch

A 1–4 player co-op action roguelike. The Wardens of the Last Bell descend into the Glimmergrave, a drowned crypt
where the Bone Regent hoards *glimmer* (crystallised soul-light) to raise an endless host. The hook is
**Resonance**: every hero can infuse abilities with Ember, Rime or Storm, and striking an enemy that carries one
element with a *different* one detonates it. One player can build a combo alone; a party that mixes elements
turns every fight into a chain reaction.

## Core gameplay loop

1. Host creates a session, friends join with a 5-letter code, everyone picks a class and readies up.
2. Enter a chamber → waves of undead rise → move, dash, attack, trigger Resonance.
3. Chamber cleared → every hero drafts 1 of 3 boons (downed heroes get back up).
4. Two exits open with different stakes (Boon / Blessing / Cursed). The party chooses by walking into one together.
5. Repeat for 8 chambers in three acts: combat ×3, elite (Crypt Champion), combat ×2, herald (a weaker form of
   one of the bosses that is not this run's final boss), then the final boss — the Bone Regent, the Hex Matron
   or the Ossuary Stalker, drawn per run.
6. After the final boss the party chooses a door: **ascend** (bank the win) or **descend** one depth deeper —
   the eight chambers start over with much stronger enemies, elite affixes, another final boss and better
   rewards. Falling below depth 0 still counts as a won run.
7. Run summary with Glimmer, class experience and relic shards → Progression hub → next run.

A full run takes 10–15 minutes. The first enemy is on screen within ~15 seconds of starting a run.

## Game rules

- Top-down 3D camera. WASD move, mouse aims, LMB primary (combo chain), RMB secondary (cooldown),
  Q ultimate (needs a full charge), Space or Shift dash (invulnerable), F as an alternative for the secondary, Esc menu, Tab scoreboard/boons.
  Reviving needs no key: stand next to a downed ally for 3 s.
- Classes: Knight (sword & shield, bash stuns), Barbarian (axe, whirlwind), Mage (arc bolts, nova),
  Rogue (crossbow, knife fan, two dash charges). Data: `shared/src/data/classes.ts`.
- Elements: Ember → Burn (damage over time), Rime → Chill (slow), Storm → Shock (takes more damage).
  Different element on a marked enemy → Resonance burst (area damage, spreads the new element).
- Update 3 adds Templar (two-handed sword, hallowed ground heals), Spellblade (melee combo ending in a blade
  wave, blink) and Shade (twin daggers, backstab, marks). Every class has a primary chain, a secondary, an
  alternative secondary ("art", unlocked by mastery) and an ultimate charged by fighting.
- Fourth element Umbra → Wither (deals less damage, hits on it heal). Each pair of elements has a named
  reaction on top of the burst: Shatter, Conflagration, Superconduct, Soulfire, Entomb, Void Arc
  (`shared/src/data/reactions.ts`).
- Boons (80): infusions, offense, defense, mobility, element, resonance, kinship (co-op), ultimate, class
  (two per class) and legendary duo boons (one per reaction). Stack up to 3 levels. Owning enough boons of
  one element or category switches on a two-tier set bonus.
- Enemies: Minion (swarm), Warrior (shielded), Archer (ranged), Mage (ground blasts), Crypt Champion (elite),
  Bone Regent (3-phase boss). Every dangerous attack is telegraphed on the ground before it lands.
- Co-op: downed heroes are revived by an ally standing next to them for 3 s; all revive when a chamber is cleared.
  Solo players get one Second Wind per run. Enemy health and numbers scale with party size.
- Acts and biomes: act 1 is the Crypt; acts 2 and 3 are the Flooded Catacombs and the Ember Forge in seeded
  order. Each biome has its own room shapes, obstacles and floor hazard (spikes, frost mist, fire vents).
  Hazards cycle idle → warning → active, hurt heroes and enemies alike, and never hit dashing heroes.
- Chamber objectives (update 4, `docs/milestones/update-4.md`): every combat chamber has one of six objectives
  shown on its door — slay, survive, defend the bell shard, hunt marked elites, light three braziers, or a
  vault without a fight. Special objectives have a bonus condition that upgrades the draft and pays Glimmer.
- Enemies since update 4: Shaman (mends, interruptible), Aegis (ward dome), Bomber (fuse, also bursts when
  slain), Necromancer (raises minions that crumble with it), Reaver (leaps onto the backline); warded enemies
  ignore one element from chamber 5 on.
- Endless progression (update 3, `docs/milestones/update-3.md`): Armory (18 upgrades), Ascension (endless
  ranks, diminishing returns), class mastery (levels without a cap, an art and 6 talents per class), relics
  (20, ranks 1–10 from shards, 1–3 slots) and the Chronicle (16 feats that pay Glimmer). Oath levels 0–20.
- Permanent progression: every run pays Glimmer (win or lose). The Armory sells nine upgrades in levels
  (`shared/src/data/meta.ts`): health, damage, speed, cooldowns, draft rerolls, a starting Infusion, tougher
  revives, more Glimmer. Balance assumes upgrades matter: a fresh solo hero wins about a third of runs.
- Customisation (cosmetic): cloth colour, headgear, cape and three gear styles per class, with a 3D preview.
- Training: a three-minute guided solo session teaches movement, dash, the three elements, Resonance, hazards,
  drafts and doors. In-run tips, an element strip on the HUD and a Codex keep the rules visible afterwards.
- Risk/reward: Cursed doors make the next chamber's enemies elite but grant a 4-choice draft with a guaranteed
  rare. Blessing doors heal 35 %. Oath level 0–3 (host setting) scales the whole run.

## Win / lose conditions

Win: the run's final boss dies. Lose: every hero is downed at the same time (and no Second Wind is left).

## Art style

Stylised low-poly 3D (KayKit, CC0): chunky heroes and skeletons, a torch-lit stone crypt, strong colour-coded
elements (Ember orange, Rime cyan, Storm violet), emissive glimmer crystals, hostile telegraphs in red.

## Audio direction

Sample-based effects (CC0 packs, see docs/AUDIO.md) layered with synthesis for the elements, plus a generative score: dark, pulsing minor-key score that intensifies in elite and boss chambers;
punchy synthesized hits; distinct timbres per element; soft UI clicks. No external audio files.

## Player goals

Short term: survive the chamber, land Resonances, pick boons that fit the party's elements.
Long term: master every class, fill the reliquary and the Chronicle, climb the Oath levels and descend deeper.

## Anti-goals

No PvP, no accounts (progress lives in the browser), no loot inventory, no procedural mazes, no mobile-first
controls (desktop browsers are the target).

## Assumptions (taken autonomously, per the brief)

- Top-down camera instead of first/third person: best readability and the most robust netcode for melee co-op.
- Permanent upgrades are stored in the browser and sent with the loadout; the server clamps every level to its
  maximum. Without accounts a tampered client can at most claim a fully upgraded hero, which is acceptable for
  a co-op game without competition (update 2, after the owner asked for character upgrades).
- UI ships in English and German (browser language decides, switchable in the settings).
