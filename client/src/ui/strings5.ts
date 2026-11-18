/**
 * Polish 1 strings: merged feed lines, the "new foes" tip card, the bonus reward on door cards, the codex tab
 * that keeps every tip readable. Merged into the main tables by i18n.ts, so every key here is a normal I18nKey.
 */
export const EN5 = {
  // ---------------------------------------------------------------- event feed: one line per topic
  'toast.ultReadyOwn': 'Ultimate ready — press {key}',
  'toast.ultReadyMany': '{n} ultimates ready',
  'toast.downMany': '{names} are down!',
  'toast.revivedMany': '{names} are back up',
  'toast.wardMany': 'Warded foes: {elements} do nothing to them',
  'toast.wardOwnMany': 'Warded against your {elements} — their statuses and bursts fail',
  'toast.affixMany': 'Elites: {affixes}',
  // ---------------------------------------------------------------- tips: several new foes share one card
  'tip.foes.title': 'New foes',
  'tip.foes.more': 'More in the Codex',
  'tip.enemy.shaman.short': 'Heals foes — interrupt or kill it first.',
  'tip.enemy.aegis.short': 'Its dome shields foes — stun or kill the bearer.',
  'tip.enemy.bomber.short': 'Bursts next to you — dash out of the circle.',
  'tip.enemy.necromancer.short': 'Raises thralls — kill it and they crumble.',
  'tip.enemy.reaver.short': 'Leaps at the hero furthest back — sidestep, then strike.',
  // ---------------------------------------------------------------- doors: what the bonus is worth
  'door.objective.reward': '+1 boon choice, rare or better, +Glimmer',
  'door.objective.rewardVault': '{hp}% health, +1 boon choice, rare or better, +Glimmer',
  'door.objective.rewardLabel': 'Reward',
  // ---------------------------------------------------------------- codex: every tip, to read again
  'codex.tab.tips': 'Tips',
  'codex.tips.intro': 'Every tip the game shows the first time something happens, to read again in peace. Tips can be switched off or brought back in the settings.',
  'codex.tips.group.basics': 'Elements and Resonance',
  'codex.tips.group.fight': 'In the fight',
  'codex.tips.group.foes': 'Foes',
  'codex.tips.group.path': 'Doors and the way down',
  'codex.tips.ally': 'An ally',
} as const;

export type Key5 = keyof typeof EN5;

export const DE5: Record<Key5, string> = {
  'toast.ultReadyOwn': 'Ultimate bereit – drücke {key}',
  'toast.ultReadyMany': '{n} Ultimates bereit',
  'toast.downMany': '{names} liegen am Boden!',
  'toast.revivedMany': '{names} stehen wieder',
  'toast.wardMany': 'Gegner mit Schutzbann: {elements} wirken nicht auf sie',
  'toast.wardOwnMany': 'Schutzbann gegen {elements} – deine Elemente wirken nicht',
  'toast.affixMany': 'Elitegegner: {affixes}',
  'tip.foes.title': 'Neue Gegner',
  'tip.foes.more': 'Mehr im Kodex',
  'tip.enemy.shaman.short': 'Heilt Gegner – unterbrich oder töte ihn zuerst.',
  'tip.enemy.aegis.short': 'Seine Kuppel schützt Gegner – betäube oder töte den Träger.',
  'tip.enemy.bomber.short': 'Explodiert neben dir – dashe aus dem Kreis.',
  'tip.enemy.necromancer.short': 'Erweckt Knechte – stirbt er, zerfallen sie.',
  'tip.enemy.reaver.short': 'Springt den Hintersten an – weich aus, dann schlag zu.',
  'door.objective.reward': '+1 Boon zur Wahl, selten oder besser, +Glimmer',
  'door.objective.rewardVault': '{hp} % Leben, +1 Boon zur Wahl, selten oder besser, +Glimmer',
  'door.objective.rewardLabel': 'Belohnung',
  'codex.tab.tips': 'Tipps',
  'codex.tips.intro': 'Jeder Tipp, den das Spiel zeigt, wenn etwas zum ersten Mal geschieht – hier in Ruhe zum Nachlesen. Tipps lassen sich in den Einstellungen abschalten oder zurückholen.',
  'codex.tips.group.basics': 'Elemente und Resonanz',
  'codex.tips.group.fight': 'Im Kampf',
  'codex.tips.group.foes': 'Gegner',
  'codex.tips.group.path': 'Türen und der Weg hinab',
  'codex.tips.ally': 'Ein Verbündeter',
};
