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
5. Repeat for 8 chambers: combat ×3, elite (Crypt Champion), combat ×2, elite, then the Bone Regent.
6. Victory or defeat → run summary → back to the lobby for the next run (higher Oath level unlocked on a win).

A full run takes 10–15 minutes. The first enemy is on screen within ~15 seconds of starting a run.

## Game rules

- Top-down 3D camera. WASD move, mouse aims, LMB primary (combo chain), RMB secondary (cooldown),
  Space or Shift dash (invulnerable), F as an alternative for the secondary, Esc menu, Tab scoreboard/boons.
  Reviving needs no key: stand next to a downed ally for 3 s.
- Classes: Knight (sword & shield, bash stuns), Barbarian (axe, whirlwind), Mage (arc bolts, nova),
  Rogue (crossbow, knife fan, two dash charges). Data: `shared/src/data/classes.ts`.
- Elements: Ember → Burn (damage over time), Rime → Chill (slow), Storm → Shock (takes more damage).
  Different element on a marked enemy → Resonance burst (area damage, spreads the new element).
- Boons (33): infusions, offense, defense, mobility, element, resonance, kinship (co-op). Stack up to 3 levels.
- Enemies: Minion (swarm), Warrior (shielded), Archer (ranged), Mage (ground blasts), Crypt Champion (elite),
  Bone Regent (3-phase boss). Every dangerous attack is telegraphed on the ground before it lands.
- Co-op: downed heroes are revived by an ally standing next to them for 3 s; all revive when a chamber is cleared.
  Solo players get one Second Wind per run. Enemy health and numbers scale with party size.
- Risk/reward: Cursed doors make the next chamber's enemies elite but grant a 4-choice draft with a guaranteed
  rare. Blessing doors heal 35 %. Oath level 0–3 (host setting) scales the whole run.

## Win / lose conditions

Win: the Bone Regent dies. Lose: every hero is downed at the same time (and no Second Wind is left).

## Art style

Stylised low-poly 3D (KayKit, CC0): chunky heroes and skeletons, a torch-lit stone crypt, strong colour-coded
elements (Ember orange, Rime cyan, Storm violet), emissive glimmer crystals, hostile telegraphs in red.

## Audio direction

Fully procedural Web Audio: dark, pulsing minor-key score that intensifies in elite and boss chambers;
punchy synthesized hits; distinct timbres per element; soft UI clicks. No external audio files.

## Player goals

Short term: survive the chamber, land Resonances, pick boons that fit the party's elements.
Long term: beat the Regent with every class and climb the Oath levels.

## Anti-goals

No PvP, no accounts, no persistent power progression, no loot inventory, no procedural mazes, no mobile-first
controls (desktop browsers are the target).

## Assumptions (taken autonomously, per the brief)

- Top-down camera instead of first/third person: best readability and the most robust netcode for melee co-op.
- Meta-progression is limited to locally stored statistics and unlocked Oath levels (no accounts → nothing a
  client could abuse; difficulty is a host choice anyway).
- UI ships in English and German (browser language decides, switchable in the settings).
