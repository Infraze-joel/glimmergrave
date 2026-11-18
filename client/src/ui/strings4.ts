/**
 * Update 4 strings ("Objectives and the Horde"): chamber objectives (HUD tracker, banner, doors, draft, summary),
 * the five new foes, warded enemies, and the codex pages Bestiary and Objectives.
 * Merged into the main tables by i18n.ts, so every key here is a normal I18nKey.
 *
 * Name, goal and bonus of an objective mirror `shared/src/data/objectives.ts` by id: English is built from the
 * table (`EN4_DATA`, cannot drift), German is written in `DE4_DATA`. Read them with `tx()`.
 */
import { OBJECTIVES } from '@shared/data/objectives.ts';
import { OBJECTIVE_KINDS } from '@shared/types.ts';

export const EN4 = {
  // ---------------------------------------------------------------- HUD tracker
  'objective.label': 'Objective',
  'objective.bonus': 'Bonus',
  'objective.bonus.lost': 'Bonus lost',
  'objective.bonus.earned': 'Bonus earned',
  'objective.bonus.reward': '+1 boon choice, rare or better · Glimmer',
  'objective.bonus.rewardShort': '+1 choice, rare or better',
  'objective.done': 'Objective complete',
  'objective.done.noBonus': 'No bonus this time',
  'objective.done.vault': 'Vault opened',
  'objective.done.vaultSub': 'Healed {hp}% · Glimmer · a richer draft',
  'objective.survive.left': 'until the bell tolls',
  'objective.defend.shard': 'Bell shard',
  'objective.defend.shattered': 'Shattered',
  'objective.defend.repair': 'Stand next to it to repair',
  'objective.hunt.one': '1 marked elite left',
  'objective.hunt.many': '{n} marked elites left',
  'objective.hunt.escort': 'Marked elites slain — clear the escort',
  'objective.hunt.enraged': 'Enraged',
  'objective.ritual.lit': '{n}/{m} lit',
  'objective.ritual.bonusTime': 'Bonus',
  'objective.vault.hold': 'Stand next to the reliquary',
  'objective.vault.opening': 'Opening…',
  'objective.lost.survive': 'A Warden is down',
  'objective.lost.defend': 'The bell shard shattered — keep fighting',
  'objective.lost.hunt': 'Time is up — the marked elites enrage',
  'objective.lost.ritual': 'The time limit has passed',
  'toast.objective.site': 'Brazier lit — {n}/{m} burn',
  'toast.objective.anchorHit': 'The bell shard is under attack',

  // ---------------------------------------------------------------- doors, draft, summary
  'door.objective.bonus': 'Bonus: {reward}',
  'door.left': 'Left door',
  'door.right': 'Right door',
  'hud.prompt.doorsObjective': 'Each door shows its chamber\'s objective — stand together in one to choose',
  'draft.bonus': 'Objective bonus: +1 choice, rare or better',
  'draft.bonus.vault': 'Vault spoils: +1 choice, rare or better',
  'summary.objectives': 'Objectives',
  'summary.objectivesValue': '{n} completed',
  'summary.bonuses.one': '1 bonus earned',
  'summary.bonuses.many': '{n} bonuses earned',

  // ---------------------------------------------------------------- foes
  'enemy.shaman.name': 'Marrow Shaman',
  'enemy.shaman.desc': 'Support. Hides behind the horde and mends wounded foes within {r} m for {v}% of their health after a {t} s channel. Throws weak hex bolts when nobody needs mending.',
  'enemy.shaman.tip': 'Stun, stagger or kill it while it channels and the heal fails. Go for it first.',
  'enemy.aegis.name': 'Aegis Bearer',
  'enemy.aegis.desc': 'Slow and sturdy with a weak strike. Raises a ward dome ({r} m): other foes inside take {v}% less damage.',
  'enemy.aegis.tip': 'The dome drops while the bearer is stunned, staggered or dead and takes {t} s to return. Break the bearer, or fight the others outside the dome.',
  'enemy.bomber.name': 'Bone Bomber',
  'enemy.bomber.desc': 'Runs at a hero, stops and bursts after a short fuse ({r} m). Its blast hurts its own side too.',
  'enemy.bomber.tip': 'Dash away when it stops. It also bursts {d} s after it is slain: kill it from range, or let it go off among its friends ({m}× damage to foes).',
  'enemy.necromancer.name': 'Gravecaller',
  'enemy.necromancer.desc': 'Keeps away and raises {n} thralls at a time, up to {max}.',
  'enemy.necromancer.tip': 'Its thralls crumble when it dies. Cut your way to it instead of fighting the swarm.',
  'enemy.reaver.name': 'Crypt Reaver',
  'enemy.reaver.desc': 'Leaps onto the hero furthest from the fight, then strikes fast. Fragile.',
  'enemy.reaver.tip': 'A circle marks where it lands ({t} s): step out, then cut it down. In the back line, keep a dash ready.',

  'tip.enemy.title': 'New foe: {name}',
  'tip.enemy.shaman.body': 'It [[b|mends]] wounded foes around it after a {t} s channel. [[b|Stun, stagger or kill it]] during the channel and the heal fails.',
  'tip.enemy.aegis.body': 'Foes inside its [[b|ward dome]] take {v}% less damage. The dome [[b|drops while the bearer is stunned, staggered or dead]].',
  'tip.enemy.bomber.body': 'It runs at you, stops and [[b|bursts]]. Dash out of the circle. It also bursts when slain — and its blast [[b|hurts other foes]].',
  'tip.enemy.necromancer.body': 'It keeps raising thralls from a distance. [[b|Kill it and its thralls crumble]] with it.',
  'tip.enemy.reaver.body': 'It [[b|leaps onto whoever stands furthest back]]. Leave the landing circle, then strike: it is fragile.',
  'tip.ward.title': 'Warded foes',
  'tip.ward.body': 'A foe with a {element} ward ignores that element: no status, no Resonance burst from it. Hits still hurt. [[b|Use another element]] or leave it to an ally.',
  'tip.objective.title': 'Chamber objectives',
  'tip.objective.body': 'Every door now shows [[b|what its chamber asks of you]]. Meet the [[b|bonus]] condition and that chamber\'s draft gets one more choice, rare or better, plus Glimmer.',
  'ward.name': '{element} ward',
  'toast.ward': 'Warded foes: {element} does nothing to them',
  'toast.wardOwn': 'Warded against your {element} — its status and bursts fail',

  // ---------------------------------------------------------------- codex
  'codex.tab.bestiary': 'Bestiary',
  'codex.tab.objectives': 'Objectives',
  'codex.bestiary.intro': 'Nine kinds of foe fill the chambers. Four fight you head-on; five force a change of plan. Every dangerous attack is marked on the floor first.',
  'codex.bestiary.core': 'The horde',
  'codex.bestiary.special': 'Troublemakers',
  'codex.bestiary.from': 'From chamber {n}',
  'codex.bestiary.rule': 'A wave never holds more than one Aegis Bearer and one Gravecaller per two Wardens, and never only support foes.',
  'codex.bestiary.ward.title': 'Warded foes',
  'codex.bestiary.ward.body': 'From chamber {n} on, some of the rank and file carry a ward against one element (more of them deeper down, never a whole wave). That element\'s status and Resonance bursts do nothing to them; plain damage still does. A second element, or an ally with a different one, deals with them.',
  'codex.objectives.intro': 'Every combat chamber has an objective, and the door shows it before you choose. The first chamber, elite chambers and boss chambers are always Slaughter.',
  'codex.objectives.bonus.title': 'Bonus',
  'codex.objectives.bonus.body': 'Special objectives carry a bonus condition. Meet it and that chamber\'s draft offers {n} more choice with a rare or better boon guaranteed, and every Warden earns {g} Glimmer (scaled by Oath and depth).',
  'codex.objectives.doors': 'Two doors never offer the same special objective. Door types and objectives combine freely — a cursed Hunt is both.',
  'codex.objectives.noBonus': 'No bonus condition',
  'objective.slay.detail': 'The classic chamber: the horde comes in waves. When the last foe falls, the doors open.',
  'objective.survive.detail': 'Foes keep arriving for {a}–{b} s (longer in later chambers). When the timer ends the rest crumbles. Nothing has to die — staying on your feet is the job.',
  'objective.defend.detail': 'A bell shard stands in the room and {share}% of each wave goes for it. Stand within {r} m to repair it slowly between hits. If it shatters only the bonus is lost; the fight goes on.',
  'objective.hunt.detail': '{n} marked elites (more for a larger party) arrive with an escort. After {t} s they enrage: +{dmg}% damage, +{spd}% speed. The chamber ends when they and the escort are dead.',
  'objective.ritual.detail': '{n} braziers. A Warden inside a circle lights it in {t} s; each extra Warden adds {x}% speed. An empty circle slowly loses progress, a lit brazier stays lit. Foes keep coming until all burn.',
  'objective.vault.detail': 'No fight. Stand next to the reliquary to open it: {hp}% health back, Glimmer, and a draft with {n} more choice, rare or better. At most {max} per depth, never behind a cursed door.',

  // ---------------------------------------------------------------- settings (shorter options: the row fits at normal size)
  'settings.cursor.largeShort': 'Large',
  'settings.cursor.systemShort': 'System',
} as const;

export type Key4 = keyof typeof EN4;

export const DE4: Record<Key4, string> = {
  // ---------------------------------------------------------------- HUD tracker
  'objective.label': 'Ziel',
  'objective.bonus': 'Bonus',
  'objective.bonus.lost': 'Bonus verloren',
  'objective.bonus.earned': 'Bonus verdient',
  'objective.bonus.reward': '+1 Boon zur Wahl, selten oder besser · Glimmer',
  'objective.bonus.rewardShort': '+1 Boon zur Wahl, selten oder besser',
  'objective.done': 'Ziel erfüllt',
  'objective.done.noBonus': 'Diesmal ohne Bonus',
  'objective.done.vault': 'Gewölbe geöffnet',
  'objective.done.vaultSub': '{hp}\u00a0% geheilt · Glimmer · reichere Auswahl',
  'objective.survive.left': 'bis die Glocke schlägt',
  'objective.defend.shard': 'Glockensplitter',
  'objective.defend.shattered': 'Zerbrochen',
  'objective.defend.repair': 'Stell dich daneben, um ihn zu reparieren',
  'objective.hunt.one': 'Noch 1 markierter Elitegegner',
  'objective.hunt.many': 'Noch {n} markierte Elitegegner',
  'objective.hunt.escort': 'Markierte Elite erschlagen – räumt die Eskorte',
  'objective.hunt.enraged': 'In Raserei',
  'objective.ritual.lit': '{n}/{m} brennen',
  'objective.ritual.bonusTime': 'Bonus',
  'objective.vault.hold': 'Stellt euch an den Reliquienschrein',
  'objective.vault.opening': 'Öffnet sich …',
  'objective.lost.survive': 'Ein Wächter liegt am Boden',
  'objective.lost.defend': 'Der Glockensplitter ist zerbrochen – kämpft weiter',
  'objective.lost.hunt': 'Die Zeit ist um – die markierte Elite gerät in Raserei',
  'objective.lost.ritual': 'Das Zeitlimit ist verstrichen',
  'toast.objective.site': 'Feuerschale entzündet – {n}/{m} brennen',
  'toast.objective.anchorHit': 'Der Glockensplitter wird angegriffen',

  // ---------------------------------------------------------------- doors, draft, summary
  'door.objective.bonus': 'Bonus: {reward}',
  'door.left': 'Linke Tür',
  'door.right': 'Rechte Tür',
  'hud.prompt.doorsObjective': 'Jede Tür zeigt das Ziel ihrer Kammer – stellt euch gemeinsam in eine',
  'draft.bonus': 'Zielbonus: +1 Boon zur Wahl, selten oder besser',
  'draft.bonus.vault': 'Gewölbebeute: +1 Boon zur Wahl, selten oder besser',
  'summary.objectives': 'Ziele',
  'summary.objectivesValue': '{n} erfüllt',
  'summary.bonuses.one': '1 Bonus verdient',
  'summary.bonuses.many': '{n} Boni verdient',

  // ---------------------------------------------------------------- foes
  'enemy.shaman.name': 'Markschamane',
  'enemy.shaman.desc': 'Unterstützer. Versteckt sich hinter der Horde und heilt verwundete Gegner im Umkreis von {r} m nach {t} s Kanalisieren um {v}\u00a0% ihres Lebens. Wirft schwache Fluchgeschosse, wenn niemand Heilung braucht.',
  'enemy.shaman.tip': 'Betäube ihn, bring ihn ins Taumeln oder töte ihn beim Kanalisieren, dann verpufft die Heilung. Nimm ihn zuerst.',
  'enemy.aegis.name': 'Aegisträger',
  'enemy.aegis.desc': 'Langsam und zäh, schlägt schwach zu. Errichtet eine Schutzkuppel ({r} m): Andere Gegner darin erleiden {v}\u00a0% weniger Schaden.',
  'enemy.aegis.tip': 'Die Kuppel fällt, solange der Träger betäubt ist, taumelt oder tot ist, und braucht {t} s, bis sie wieder steht. Brich den Träger oder bekämpfe die anderen außerhalb der Kuppel.',
  'enemy.bomber.name': 'Knochenbomber',
  'enemy.bomber.desc': 'Rennt auf einen Helden zu, bleibt stehen und explodiert nach kurzer Lunte ({r} m). Die Explosion trifft auch seine eigene Seite.',
  'enemy.bomber.tip': 'Dashe weg, sobald er stehen bleibt. Er explodiert auch {d} s nach seinem Tod: Töte ihn aus der Ferne oder lass ihn zwischen seinen Freunden hochgehen ({m}× Schaden an Gegnern).',
  'enemy.necromancer.name': 'Grabrufer',
  'enemy.necromancer.desc': 'Hält Abstand und erweckt jeweils {n} Knechte, bis zu {max} gleichzeitig.',
  'enemy.necromancer.tip': 'Seine Knechte zerfallen, wenn er stirbt. Schlag dich zu ihm durch, statt den Schwarm zu bekämpfen.',
  'enemy.reaver.name': 'Gruftreißer',
  'enemy.reaver.desc': 'Springt auf den Helden, der am weitesten vom Kampf entfernt steht, und schlägt dann schnell zu. Zerbrechlich.',
  'enemy.reaver.tip': 'Ein Kreis zeigt, wo er landet ({t} s): Geh hinaus und schlag ihn dann nieder. Halte in der hinteren Reihe einen Dash bereit.',

  'tip.enemy.title': 'Neuer Gegner: {name}',
  'tip.enemy.shaman.body': 'Er [[b|heilt]] verwundete Gegner um sich herum nach {t} s Kanalisieren. [[b|Betäube ihn, bring ihn ins Taumeln oder töte ihn]] währenddessen, dann verpufft die Heilung.',
  'tip.enemy.aegis.body': 'Gegner in seiner [[b|Schutzkuppel]] erleiden {v}\u00a0% weniger Schaden. Die Kuppel [[b|fällt, solange der Träger betäubt ist, taumelt oder tot ist]].',
  'tip.enemy.bomber.body': 'Er rennt auf dich zu, bleibt stehen und [[b|explodiert]]. Dashe aus dem Kreis. Er explodiert auch, wenn er stirbt – und seine Explosion [[b|trifft andere Gegner]].',
  'tip.enemy.necromancer.body': 'Er erweckt aus der Ferne immer neue Knechte. [[b|Töte ihn, dann zerfallen seine Knechte]] mit ihm.',
  'tip.enemy.reaver.body': 'Er [[b|springt auf den, der am weitesten hinten steht]]. Verlass den Landekreis und schlag dann zu: Er ist zerbrechlich.',
  'tip.ward.title': 'Gegner mit Schutzbann',
  'tip.ward.body': 'Ein Gegner mit {element}-Schutzbann ignoriert dieses Element: kein Status, keine Resonanz-Explosion daraus. Treffer schaden weiterhin. [[b|Nutze ein anderes Element]] oder überlass ihn einem Verbündeten.',
  'tip.objective.title': 'Kammerziele',
  'tip.objective.body': 'Jede Tür zeigt jetzt, [[b|was ihre Kammer von euch verlangt]]. Erfüllt ihr die [[b|Bonus]]-Bedingung, bietet die Auswahl dieser Kammer einen Boon mehr, selten oder besser, und es gibt Glimmer.',
  'ward.name': '{element}-Schutzbann',
  'toast.ward': 'Gegner mit Schutzbann: {element} wirkt nicht auf sie',
  'toast.wardOwn': 'Schutzbann gegen {element} – dein Element wirkt nicht',

  // ---------------------------------------------------------------- codex
  'codex.tab.bestiary': 'Bestiarium',
  'codex.tab.objectives': 'Ziele',
  'codex.bestiary.intro': 'Neun Arten von Gegnern füllen die Kammern. Vier kämpfen geradeheraus, fünf zwingen dich umzudenken. Jeder gefährliche Angriff wird vorher auf dem Boden markiert.',
  'codex.bestiary.core': 'Die Horde',
  'codex.bestiary.special': 'Störenfriede',
  'codex.bestiary.from': 'Ab Kammer {n}',
  'codex.bestiary.rule': 'Eine Welle enthält nie mehr als einen Aegisträger und einen Grabrufer je zwei Wächter und nie ausschließlich Unterstützer.',
  'codex.bestiary.ward.title': 'Gegner mit Schutzbann',
  'codex.bestiary.ward.body': 'Ab Kammer {n} tragen manche einfachen Gegner einen Schutzbann gegen ein Element (in der Tiefe mehr, nie eine ganze Welle). Status und Resonanz-Explosionen dieses Elements bewirken bei ihnen nichts, normaler Schaden schon. Ein zweites Element oder ein Verbündeter mit einem anderen erledigt sie.',
  'codex.objectives.intro': 'Jede Kampfkammer hat ein Ziel, und die Tür zeigt es, bevor ihr wählt. Die erste Kammer sowie Elite- und Bosskammern sind immer Gemetzel.',
  'codex.objectives.bonus.title': 'Bonus',
  'codex.objectives.bonus.body': 'Besondere Ziele haben eine Bonus-Bedingung. Erfüllt ihr sie, bietet die Auswahl dieser Kammer {n} Boon mehr mit einem garantierten seltenen oder besseren, und jeder Wächter erhält {g} Glimmer (skaliert mit Eid und Tiefe).',
  'codex.objectives.doors': 'Zwei Türen bieten nie dasselbe besondere Ziel. Türarten und Ziele sind frei kombinierbar – eine verfluchte Jagd ist beides.',
  'codex.objectives.noBonus': 'Keine Bonus-Bedingung',
  'objective.slay.detail': 'Die klassische Kammer: Die Horde kommt in Wellen. Fällt der letzte Gegner, öffnen sich die Türen.',
  'objective.survive.detail': 'Gegner strömen {a}–{b} s lang nach (in späteren Kammern länger). Läuft die Zeit ab, zerfällt der Rest. Nichts muss sterben – auf den Beinen zu bleiben ist die Aufgabe.',
  'objective.defend.detail': 'Ein Glockensplitter steht im Raum und {share}\u00a0% jeder Welle greifen ihn an. Stell dich innerhalb von {r} m daneben, um ihn zwischen Treffern langsam zu reparieren. Zerbricht er, ist nur der Bonus verloren; der Kampf geht weiter.',
  'objective.hunt.detail': '{n} markierte Elitegegner (bei größerer Gruppe mehr) kommen mit einer Eskorte. Nach {t} s geraten sie in Raserei: +{dmg}\u00a0% Schaden, +{spd}\u00a0% Tempo. Die Kammer endet, wenn sie und die Eskorte tot sind.',
  'objective.ritual.detail': '{n} Feuerschalen. Ein Wächter im Kreis entzündet sie in {t} s; jeder weitere Wächter gibt {x}\u00a0% Tempo dazu. Ein leerer Kreis verliert langsam Fortschritt, eine brennende Schale bleibt an. Gegner kommen, bis alle brennen.',
  'objective.vault.detail': 'Kein Kampf. Stellt euch an den Reliquienschrein, um ihn zu öffnen: {hp}\u00a0% Leben zurück, Glimmer und eine Auswahl mit {n} Boon mehr, selten oder besser. Höchstens {max} je Tiefe, nie hinter einer verfluchten Tür.',

  // ---------------------------------------------------------------- settings
  'settings.cursor.largeShort': 'Groß',
  'settings.cursor.systemShort': 'System',
};

// ------------------------------------------------------------------ texts that mirror data/objectives.ts by id

function buildEnglish(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of OBJECTIVE_KINDS) {
    const def = OBJECTIVES[kind];
    out[`objective.${kind}.name`] = def.name;
    out[`objective.${kind}.goal`] = def.goal;
    if (def.bonus !== '') out[`objective.${kind}.bonus`] = def.bonus;
  }
  return out;
}

/** objective.<kind>.name | .goal | .bonus (no `.bonus` key for objectives without a bonus condition). */
export const EN4_DATA: Readonly<Record<string, string>> = buildEnglish();

export const DE4_DATA: Readonly<Record<string, string>> = {
  'objective.slay.name': 'Gemetzel',
  'objective.slay.goal': 'Räumt jede Welle.',
  'objective.survive.name': 'Durchhalten',
  'objective.survive.goal': 'Überlebt, bis die Glocke schlägt.',
  'objective.survive.bonus': 'Niemand liegt am Boden, wenn die Zeit endet.',
  'objective.defend.name': 'Splitterwacht',
  'objective.defend.goal': 'Räumt die Wellen, solange der Glockensplitter steht.',
  'objective.defend.bonus': 'Der Splitter übersteht den Kampf.',
  'objective.hunt.name': 'Die Jagd',
  'objective.hunt.goal': 'Erschlagt die markierten Elitegegner.',
  'objective.hunt.bonus': 'Alle fallen, bevor die Zeit abläuft.',
  'objective.ritual.name': 'Feuerritual',
  'objective.ritual.goal': 'Steht in jedem Kreis, bis seine Feuerschale brennt.',
  'objective.ritual.bonus': 'Alle Schalen brennen innerhalb des Zeitlimits.',
  'objective.vault.name': 'Versiegeltes Gewölbe',
  'objective.vault.goal': 'Keine Gegner. Öffnet den Reliquienschrein.',
};
