/**
 * All user-visible text (English + German). Pure module: no DOM access, so it is unit-testable.
 *
 * Key conventions (flat, dot-separated):
 *   common.* menu.* lobby.* hud.* draft.* tab.* settings.* summary.* howto.* controls.* loading.*
 *   class.<classId>.name|role            class.<classId>.<primary|secondary|dash>.name|desc
 *   enemy.<kind>.name|desc               element.<id>.name   status.<id>.name|desc
 *   boon.<boonId>.name|desc              infusion.<element>.<slot>.name   infusion.desc   infusion.slot.<slot>
 *   door.<type>.name|desc                oath.<0..3>.name    oath.desc    oath.0.desc
 *   rarity.<rarity>   category.<category>   toast.*   error.<ErrorCode | ConnError>
 * Update 4 keys (objectives, the new foes, wards) live in strings4.ts.
 * Update 3 keys live in strings3.ts; texts that mirror a data table by id are looked up with `tx()` (strings3data.ts).
 * Update 2 keys (tutorial.* tip.* codex.* armory.* meta.* wardrobe.* look.* biome.* hazard.*) live in strings2.ts.
 * Placeholders use {name}. Boon descriptions use {v} for the value at the offered level.
 */
import { RUN } from '@shared/constants.ts';
import { BOON_BY_ID, BOON_TUNING, type BoonDef } from '@shared/data/boons.ts';
import type { Lang } from '../core/Settings.ts';
import { DE2, EN2 } from './strings2.ts';
import { DE3, EN3 } from './strings3.ts';
import { DE_DATA, EN_DATA } from './strings3data.ts';
import { DE4, DE4_DATA, EN4, EN4_DATA } from './strings4.ts';

const EN = {
  ...EN2,
  ...EN3,
  ...EN4,
  'common.title': 'Glimmergrave',
  'common.tagline': 'A co-op descent for 1–4 Wardens',
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.leave': 'Leave',
  'common.retry': 'Retry',
  'common.copied': 'Copied!',
  'common.copyFailed': 'Could not copy',
  'common.level': 'Level {n}',
  'common.you': 'You',
  'common.and': 'and',

  'loading.title': 'Descending…',
  'loading.percent': '{n}%',
  'loading.flavour.0': 'The Last Bell tolls for the Wardens.',
  'loading.flavour.1': 'Glimmer is soul-light, crystallised. The Regent hoards it.',
  'loading.flavour.2': 'Two different elements on one foe make it burst.',
  'loading.flavour.3': 'Nobody is invulnerable. Except mid-dash.',
  'loading.flavour.4': 'A crypt is best cleared with friends.',
  'loading.errorTitle': 'The crypt stays sealed',
  'loading.errorBody': 'The game files could not be loaded. Check your connection and try again.',

  'menu.name': 'Your name',
  'menu.namePlaceholder': 'Warden',
  'menu.defaultName': 'Warden',
  'menu.class': 'Choose your Warden',
  'menu.host': 'Host game',
  'menu.join': 'Join',
  'menu.joinLabel': 'Join with a code',
  'menu.codePlaceholder': 'Code',
  'menu.howto': 'How to play',
  'menu.settings': 'Settings',
  'menu.profile': 'Your record',
  'menu.stat.runs': 'Runs',
  'menu.stat.wins': 'Wins',
  'menu.stat.best': 'Deepest',
  'menu.stat.oath': 'Oath',
  'menu.stat.bestValue': '{n}/{total}',
  'menu.connecting': 'Opening the gate…',
  'menu.connectingHint': 'Connecting to the server',
  'menu.health': 'Health',
  'menu.speed': 'Speed',
  'menu.selected': 'Selected',

  'class.knight.name': 'Knight',
  'class.knight.role': 'Stalwart frontliner',
  'class.knight.primary.name': 'Sword Combo',
  'class.knight.primary.desc': 'Three-hit chain; the finisher knocks back.',
  'class.knight.secondary.name': 'Shield Bash',
  'class.knight.secondary.desc': 'Lunge, stun foes and gain a shield.',
  'class.knight.dash.name': 'Dash',
  'class.knight.dash.desc': 'Short invulnerable burst.',
  'class.barbarian.name': 'Barbarian',
  'class.barbarian.role': 'Wide-swinging bruiser',
  'class.barbarian.primary.name': 'Cleave',
  'class.barbarian.primary.desc': 'Heavy axe sweeps with huge reach.',
  'class.barbarian.secondary.name': 'Whirlwind',
  'class.barbarian.secondary.desc': 'Spin and shred everything around you.',
  'class.barbarian.dash.name': 'Dash',
  'class.barbarian.dash.desc': 'Short invulnerable burst.',
  'class.mage.name': 'Mage',
  'class.mage.role': 'Fragile long-range caster',
  'class.mage.primary.name': 'Arc Bolt',
  'class.mage.primary.desc': 'Fast bolts across the whole chamber.',
  'class.mage.secondary.name': 'Nova',
  'class.mage.secondary.desc': 'Delayed blast at your cursor.',
  'class.mage.dash.name': 'Dash',
  'class.mage.dash.desc': 'Short invulnerable burst.',
  'class.rogue.name': 'Rogue',
  'class.rogue.role': 'Swift skirmisher',
  'class.rogue.primary.name': 'Crossbow',
  'class.rogue.primary.desc': 'Rapid bolts that pierce one foe.',
  'class.rogue.secondary.name': 'Knife Fan',
  'class.rogue.secondary.desc': 'Five knives in a cone.',
  'class.rogue.dash.name': 'Double Dash',
  'class.rogue.dash.desc': 'Two charges, same invulnerability.',

  'enemy.minion.name': 'Bone Thrall',
  'enemy.minion.desc': 'Fast and frail. Comes in swarms.',
  'enemy.warrior.name': 'Grave Guard',
  'enemy.warrior.desc': 'Slow. Its shield soaks damage until it breaks.',
  'enemy.archer.name': 'Bone Archer',
  'enemy.archer.desc': 'Keeps its distance and fires along a marked line.',
  'enemy.mage.name': 'Hex Caller',
  'enemy.mage.desc': 'Blasts the ground beneath you and blinks away.',
  'enemy.champion.name': 'Crypt Champion',
  'enemy.champion.desc': 'Elite. Sweeps, charges and calls thralls.',
  'enemy.regent.name': 'The Bone Regent',
  'enemy.regent.desc': 'Lord of the Glimmergrave. Three phases.',

  'element.ember.name': 'Ember',
  'element.rime.name': 'Rime',
  'element.storm.name': 'Storm',
  'status.ember.name': 'Burn',
  'status.rime.name': 'Chill',
  'status.storm.name': 'Shock',
  'status.ember.desc': 'damage over time',
  'status.rime.desc': 'slows the target',
  'status.storm.desc': 'target takes more damage',

  'rarity.common': 'Common',
  'rarity.rare': 'Rare',
  'rarity.epic': 'Epic',
  'category.infusion': 'Infusion',
  'category.offense': 'Offense',
  'category.defense': 'Defense',
  'category.mobility': 'Mobility',
  'category.element': 'Element',
  'category.resonance': 'Resonance',
  'category.kinship': 'Kinship',

  'infusion.ember.primary.name': 'Ember Edge',
  'infusion.ember.secondary.name': 'Cinder Surge',
  'infusion.ember.dash.name': 'Ashen Step',
  'infusion.rime.primary.name': 'Rime Edge',
  'infusion.rime.secondary.name': 'Glacial Surge',
  'infusion.rime.dash.name': 'Hoarfrost Step',
  'infusion.storm.primary.name': 'Storm Edge',
  'infusion.storm.secondary.name': 'Thunder Surge',
  'infusion.storm.dash.name': 'Lightning Step',
  'infusion.slot.primary': 'Your primary attack',
  'infusion.slot.secondary': 'Your secondary ability',
  'infusion.slot.dash': 'Your dash',
  'infusion.desc': '{ability} applies {status} (potency ×{v}). Replaces another infusion on the same ability.',

  'boon.keen_edge.name': 'Keen Edge',
  'boon.keen_edge.desc': 'Primary attacks deal +{v}% damage.',
  'boon.heavy_hand.name': 'Heavy Hand',
  'boon.heavy_hand.desc': 'Your secondary ability deals +{v}% damage.',
  'boon.swift_strikes.name': 'Swift Strikes',
  'boon.swift_strikes.desc': 'Primary attacks are {v}% faster.',
  'boon.deadeye.name': 'Deadeye',
  'boon.deadeye.desc': '+{v}% chance to critically hit for double damage.',
  'boon.executioner.name': 'Executioner',
  'boon.executioner.desc': '+{v}% damage to enemies below {threshold}% health.',
  'boon.iron_heart.name': 'Iron Heart',
  'boon.iron_heart.desc': '+{v} maximum health (and heal that amount).',
  'boon.barrier.name': 'Barrier',
  'boon.barrier.desc': 'Gain a {v}-point shield that recharges after {recharge} s without taking damage.',
  'boon.leech.name': 'Leech',
  'boon.leech.desc': 'Heal {v} health whenever you slay an enemy.',
  'boon.last_stand.name': 'Last Stand',
  'boon.last_stand.desc': 'Once per chamber, a killing blow leaves you at 1 health and invulnerable for {invuln} s.',
  'boon.fleet_foot.name': 'Fleet Foot',
  'boon.fleet_foot.desc': '+{v}% movement speed.',
  'boon.quick_step.name': 'Quick Step',
  'boon.quick_step.desc': 'Dash recharges {v}% faster.',
  'boon.spare_step.name': 'Spare Step',
  'boon.spare_step.desc': '+1 dash charge.',
  'boon.quick_wits.name': 'Quick Wits',
  'boon.quick_wits.desc': 'Secondary cooldown reduced by {v}%.',
  'boon.wildfire.name': 'Wildfire',
  'boon.wildfire.desc': 'Burn deals +{v}% damage.',
  'boon.deep_frost.name': 'Deep Frost',
  'boon.deep_frost.desc': 'Chill slows {v}% more and chilled enemies deal {v}% less damage.',
  'boon.overcharge.name': 'Overcharge',
  'boon.overcharge.desc': 'Shocked enemies take a further +{v}% damage.',
  'boon.amplifier.name': 'Amplifier',
  'boon.amplifier.desc': 'Resonance bursts deal +{v}% damage.',
  'boon.wide_resonance.name': 'Wide Resonance',
  'boon.wide_resonance.desc': 'Resonance bursts are {v}% larger.',
  'boon.aftershock.name': 'Aftershock',
  'boon.aftershock.desc': 'Triggering a Resonance refunds a dash charge and {v}% of your secondary cooldown.',
  'boon.echo.name': 'Echo',
  'boon.echo.desc': 'Resonance has a {v}% chance to burst a second time.',
  'boon.kindred_flame.name': 'Kindred Flame',
  'boon.kindred_flame.desc': 'You and allies within {radius} m deal +{v}% damage.',
  'boon.shared_vigor.name': 'Shared Vigor',
  'boon.shared_vigor.desc': 'Your Resonance bursts heal every hero for {v}.',
  'boon.lifeline.name': 'Lifeline',
  'boon.lifeline.desc': 'Revive allies {v}% faster; revived heroes return with {v}% more health.',
  'boon.oathbond.name': 'Oathbond',
  'boon.oathbond.desc': 'When an ally falls (or you drop below {threshold}% health) gain +{v}% damage and haste for {duration} s.',

  'door.boon.name': 'Boon',
  'door.boon.desc': 'Draft 1 of {c} boons',
  'door.blessing.name': 'Blessing',
  'door.blessing.desc': 'Heals the party {v}% + a draft',
  'door.cursed.name': 'Cursed',
  'door.cursed.desc': 'Empowered foes · {n} choices, one rare',
  'door.boss.name': 'Final boss',
  'door.boss.desc': '{boss} awaits',

  'oath.label': 'Oath',
  'oath.badge': 'Oath {n}',
  'oath.0.name': 'Unsworn',
  'oath.1.name': 'Oath of Iron',
  'oath.2.name': 'Oath of Ash',
  'oath.3.name': 'Oath of the Last Bell',
  'oath.0.desc': 'The standard descent. No modifiers.',
  'oath.desc': 'Enemies: +{hp}% health, +{dmg}% damage, +{spd}% speed.',
  'oath.locked': 'Win a run at Oath {n} to unlock.',

  'chamber.combat': 'Combat',
  'chamber.elite': 'Elite',
  'chamber.boss': 'Boss',

  'lobby.title': 'Gathering Hall',
  'lobby.code': 'Session code',
  'lobby.copyCode': 'Copy code',
  'lobby.copyLink': 'Copy invite link',
  'lobby.slotEmpty': 'Open slot',
  'lobby.slotEmptyHint': 'Share the code to invite a friend',
  'lobby.host': 'Host',
  'lobby.ready': 'Ready',
  'lobby.notReady': 'Not ready',
  'lobby.disconnected': 'Disconnected',
  'lobby.yourClass': 'Your class',
  'lobby.readyUp': 'Ready up',
  'lobby.unready': 'Not ready',
  'lobby.start': 'Start run',
  'lobby.waitingHost': 'Waiting for the host to start…',
  'lobby.reason.selfNotReady': 'Ready up to start.',
  'lobby.reason.othersNotReady': 'Waiting for {names}.',
  'lobby.reason.go': 'Everyone is ready. Ring the bell!',
  'lobby.oathHostOnly': 'The host chooses the Oath.',
  'lobby.leaveTitle': 'Leave the session?',
  'lobby.leaveBody': 'You will return to the main menu.',

  'hud.wave': 'Wave {n}/{m}',
  'hud.enemies.one': '1 enemy left',
  'hud.enemies.many': '{n} enemies left',
  'hud.phase.draft': 'Chamber cleared',
  'hud.phase.doors': 'Choose your path',
  'hud.chamber': 'Chamber {n}/{m}',
  'hud.entered.cursed': 'Cursed',
  'hud.entered.blessing': 'Blessed',
  'hud.key.primary': 'LMB',
  'hud.key.secondary': 'RMB',
  'hud.key.dash': 'Space',
  'hud.ping': '{n} ms',
  'hud.reconnecting': 'Connection lost — reconnecting…',
  'hud.downed': 'Downed',
  'hud.dead': 'Fallen',
  'hud.disconnected': 'Disconnected',
  'hud.prompt.doors': 'Stand together in a doorway to choose your path',
  'hud.prompt.downed': 'You are down — an ally can revive you',
  'hud.prompt.beingRevived': 'An ally is reviving you…',
  'hud.prompt.downedSolo': 'You are down',
  'hud.prompt.secondWind.one': 'Second Wind: 1 left',
  'hud.prompt.secondWind.many': 'Second Winds: {n} left',
  'hud.prompt.secondWind.none': 'No Second Wind left',
  'hud.prompt.reviveHint': 'Stand close to {name} to revive',
  'hud.prompt.reviving': 'Reviving {name}…',
  'hud.secondWind': 'Second Wind',

  'toast.wave': 'Wave {n}',
  'toast.waveSub': 'of {m}',
  'toast.waveFinal': 'Final wave',
  'toast.chamberClear': 'Chamber cleared',
  'toast.chamberClearSub': 'Everyone standing — choose a boon',
  'toast.bossPhase': '{name} — Phase {n}',
  'toast.bossPhaseSub': 'The dead answer its rage',
  'toast.boon': '{name} took {boon}',
  'toast.boonLevel': '{name} raised {boon} to level {n}',
  'toast.down': '{name} is down!',
  'toast.revived': '{by} revived {name}',
  'toast.revivedSelf': '{name} is back up',
  'toast.door.boon': 'A Boon path',
  'toast.door.boonSub': 'A fresh draft awaits beyond',
  'toast.door.blessing': 'A Blessed path',
  'toast.door.blessingSub': 'Clear it and the party is healed',
  'toast.door.cursed': 'A Cursed path',
  'toast.door.cursedSub': 'Empowered foes, richer spoils',
  'toast.door.boss': 'The Last Hall',
  'toast.door.bossSub': '{boss} awaits',

  'draft.title': 'Choose a Boon',
  'draft.sub': 'Chamber {n} cleared',
  'draft.subCursed': 'Cursed spoils — one extra choice, a rare guaranteed',
  'draft.new': 'New',
  'draft.upgrade': 'Upgrade',
  'draft.timer': '{n} s',
  'draft.waiting': 'Waiting for {names}…',
  'draft.waitingTitle': 'Boon claimed',
  'draft.auto': 'A boon is chosen for you when the time runs out.',

  'tab.title': 'The Party',
  'tab.hero': 'Warden',
  'tab.damage': 'Damage',
  'tab.kills': 'Kills',
  'tab.resonances': 'Resonances',
  'tab.revives': 'Revives',
  'tab.downs': 'Downs',
  'tab.boons': 'Boons',
  'tab.noBoons': 'No boons yet',
  'tab.yourBoons': 'Your boons',
  'tab.time': 'Time',

  'settings.title': 'Settings',
  'settings.paused': 'Menu',
  'settings.pausedHint': 'The run continues while this menu is open.',
  'settings.audio': 'Audio',
  'settings.master': 'Master volume',
  'settings.music': 'Music',
  'settings.sfx': 'Effects',
  'settings.video': 'Display',
  'settings.quality': 'Quality',
  'settings.quality.low': 'Low',
  'settings.quality.medium': 'Medium',
  'settings.quality.high': 'High',
  'settings.shake': 'Screen shake',
  'settings.zoom': 'Camera distance',
  'settings.damageNumbers': 'Damage numbers',
  'settings.language': 'Language',
  'settings.controls': 'Controls',
  'settings.resume': 'Resume',
  'settings.leave': 'Leave session',
  'settings.leaveTitle': 'Leave the session?',
  'settings.leaveBody': 'Your party fights on without you. You can rejoin with the code while your slot is held.',
  'settings.leaveConfirm': 'Leave session',

  'controls.move': 'Move',
  'controls.aim': 'Aim',
  'controls.primary': 'Primary attack (combo)',
  'controls.secondary': 'Secondary ability',
  'controls.dash': 'Dash (invulnerable)',
  'controls.revive': 'Stand next to a downed ally to revive them',
  'controls.scoreboard': 'Scoreboard and boons (hold)',
  'controls.menu': 'Menu',
  'controls.pick': 'Pick a boon',
  'controls.mouse': 'Mouse',

  'howto.title': 'How to play',
  'howto.1': 'Move with WASD and aim with the mouse. Dash with Space — you are invulnerable while dashing.',
  'howto.2': 'Left click chains your primary attack, right click fires your secondary ability on a cooldown.',
  'howto.3': 'Infusion boons add an element to an ability: Ember burns, Rime chills, Storm shocks, Umbra withers.',
  'howto.4': 'Resonance: hit a marked foe with a different element and it bursts, spreading the new element.',
  'howto.5': 'Stand by a downed ally to revive them. After each chamber: draft a boon, then pick a door together.',

  'summary.victory': 'Victory',
  'summary.victorySub': '{boss} has fallen. The Last Bell rings on.',
  'summary.defeat': 'Defeat',
  'summary.defeatSub': 'The Glimmergrave keeps its dead. For now.',
  'summary.chamber': 'Chamber reached',
  'summary.chamberValue': '{n} of {m}',
  'summary.time': 'Time',
  'summary.oath': 'Oath',
  'summary.mvp': 'Best of the party',
  'summary.unlocked': 'New Oath unlocked: {name}',
  'summary.unlockedHint': 'Host a run to swear it.',
  'summary.toLobby': 'Return to lobby',
  'summary.waitingHost': 'Waiting for the host…',

  'error.title': 'Something went wrong',
  'error.bad_version': 'Your game is out of date. Reload the page to update.',
  'error.room_not_found': 'No session with that code.',
  'error.room_full': 'That session is full.',
  'error.run_in_progress': 'That party is already in the crypt. Wait for them to return to the lobby.',
  'error.invalid_name': 'That name cannot be used. Pick another one.',
  'error.invalid_message': 'The server did not understand that. Please try again.',
  'error.rate_limited': 'Too many actions at once. Slow down a moment.',
  'error.not_host': 'Only the host can do that.',
  'error.not_ready': 'Not everyone is ready yet.',
  'error.session_expired': 'Your slot in that session has expired.',
  'error.server_full': 'The server is full right now. Try again in a few minutes.',
  'error.timeout': 'The server stopped hearing from you. You were disconnected.',
  'error.unreachable': 'Could not reach the server. Check your connection and try again.',
  'error.connection_lost': 'The connection to the server was lost.',
  'error.reload': 'Reload',
} as const;

export type I18nKey = keyof typeof EN;

const DE: Record<I18nKey, string> = {
  ...DE2,
  ...DE3,
  ...DE4,
  'common.title': 'Glimmergrave',
  'common.tagline': 'Ein Koop-Abstieg für 1–4 Wächter',
  'common.ok': 'OK',
  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'common.back': 'Zurück',
  'common.leave': 'Verlassen',
  'common.retry': 'Neu laden',
  'common.copied': 'Kopiert!',
  'common.copyFailed': 'Kopieren fehlgeschlagen',
  'common.level': 'Stufe {n}',
  'common.you': 'Du',
  'common.and': 'und',

  'loading.title': 'Abstieg …',
  'loading.percent': '{n} %',
  'loading.flavour.0': 'Die Letzte Glocke ruft die Wächter.',
  'loading.flavour.1': 'Glimmer ist kristallisiertes Seelenlicht. Der Regent hortet es.',
  'loading.flavour.2': 'Zwei verschiedene Elemente auf einem Gegner – und er zerbirst.',
  'loading.flavour.3': 'Niemand ist unverwundbar. Außer mitten im Dash.',
  'loading.flavour.4': 'Eine Gruft räumt man am besten mit Freunden.',
  'loading.errorTitle': 'Die Gruft bleibt versiegelt',
  'loading.errorBody': 'Die Spieldaten konnten nicht geladen werden. Prüf deine Verbindung und versuch es noch einmal.',

  'menu.name': 'Dein Name',
  'menu.namePlaceholder': 'Wächter',
  'menu.defaultName': 'Wächter',
  'menu.class': 'Wähle deinen Wächter',
  'menu.host': 'Spiel hosten',
  'menu.join': 'Beitreten',
  'menu.joinLabel': 'Mit Code beitreten',
  'menu.codePlaceholder': 'Code',
  'menu.howto': 'Spielanleitung',
  'menu.settings': 'Einstellungen',
  'menu.profile': 'Deine Bilanz',
  'menu.stat.runs': 'Runs',
  'menu.stat.wins': 'Siege',
  'menu.stat.best': 'Tiefste',
  'menu.stat.oath': 'Eid',
  'menu.stat.bestValue': '{n}/{total}',
  'menu.connecting': 'Das Tor öffnet sich …',
  'menu.connectingHint': 'Verbindung zum Server wird aufgebaut',
  'menu.health': 'Leben',
  'menu.speed': 'Tempo',
  'menu.selected': 'Gewählt',

  'class.knight.name': 'Ritter',
  'class.knight.role': 'Standhafter Frontkämpfer',
  'class.knight.primary.name': 'Schwertkombo',
  'class.knight.primary.desc': 'Drei Hiebe, der letzte stößt zurück.',
  'class.knight.secondary.name': 'Schildstoß',
  'class.knight.secondary.desc': 'Ansturm, der betäubt und dir einen Schild gibt.',
  'class.knight.dash.name': 'Dash',
  'class.knight.dash.desc': 'Kurzer, unverwundbarer Sprint.',
  'class.barbarian.name': 'Barbar',
  'class.barbarian.role': 'Wuchtiger Raufbold',
  'class.barbarian.primary.name': 'Spalten',
  'class.barbarian.primary.desc': 'Schwere Axthiebe mit enormer Reichweite.',
  'class.barbarian.secondary.name': 'Wirbelwind',
  'class.barbarian.secondary.desc': 'Wirble herum und zerfetze alles um dich.',
  'class.barbarian.dash.name': 'Dash',
  'class.barbarian.dash.desc': 'Kurzer, unverwundbarer Sprint.',
  'class.mage.name': 'Magier',
  'class.mage.role': 'Zerbrechlicher Fernkämpfer',
  'class.mage.primary.name': 'Arkanblitz',
  'class.mage.primary.desc': 'Schnelle Geschosse quer durch die Kammer.',
  'class.mage.secondary.name': 'Nova',
  'class.mage.secondary.desc': 'Verzögerte Explosion an deinem Mauszeiger.',
  'class.mage.dash.name': 'Dash',
  'class.mage.dash.desc': 'Kurzer, unverwundbarer Sprint.',
  'class.rogue.name': 'Schurke',
  'class.rogue.role': 'Flinker Plänkler',
  'class.rogue.primary.name': 'Armbrust',
  'class.rogue.primary.desc': 'Schnelle Bolzen, die einen Gegner durchschlagen.',
  'class.rogue.secondary.name': 'Messerfächer',
  'class.rogue.secondary.desc': 'Fünf Messer im Kegel.',
  'class.rogue.dash.name': 'Doppel-Dash',
  'class.rogue.dash.desc': 'Zwei Ladungen, genauso unverwundbar.',

  'enemy.minion.name': 'Knochenknecht',
  'enemy.minion.desc': 'Schnell und zerbrechlich. Kommt im Schwarm.',
  'enemy.warrior.name': 'Grabwächter',
  'enemy.warrior.desc': 'Langsam. Sein Schild schluckt Schaden, bis er bricht.',
  'enemy.archer.name': 'Knochenschütze',
  'enemy.archer.desc': 'Hält Abstand und schießt entlang einer markierten Linie.',
  'enemy.mage.name': 'Fluchrufer',
  'enemy.mage.desc': 'Sprengt den Boden unter dir und teleportiert sich weg.',
  'enemy.champion.name': 'Gruft-Champion',
  'enemy.champion.desc': 'Elite. Schwingt weit, stürmt an und ruft Knechte.',
  'enemy.regent.name': 'Der Knochenregent',
  'enemy.regent.desc': 'Herr des Glimmergrave. Drei Phasen.',

  'element.ember.name': 'Glut',
  'element.rime.name': 'Reif',
  'element.storm.name': 'Sturm',
  'status.ember.name': 'Brand',
  'status.rime.name': 'Kälte',
  'status.storm.name': 'Schock',
  'status.ember.desc': 'Schaden über Zeit',
  'status.rime.desc': 'verlangsamt das Ziel',
  'status.storm.desc': 'Ziel erleidet mehr Schaden',

  'rarity.common': 'Gewöhnlich',
  'rarity.rare': 'Selten',
  'rarity.epic': 'Episch',
  'category.infusion': 'Infusion',
  'category.offense': 'Angriff',
  'category.defense': 'Verteidigung',
  'category.mobility': 'Beweglichkeit',
  'category.element': 'Element',
  'category.resonance': 'Resonanz',
  'category.kinship': 'Verbundenheit',

  'infusion.ember.primary.name': 'Glutklinge',
  'infusion.ember.secondary.name': 'Aschenwoge',
  'infusion.ember.dash.name': 'Aschenschritt',
  'infusion.rime.primary.name': 'Reifklinge',
  'infusion.rime.secondary.name': 'Gletscherwoge',
  'infusion.rime.dash.name': 'Raureifschritt',
  'infusion.storm.primary.name': 'Sturmklinge',
  'infusion.storm.secondary.name': 'Donnerwoge',
  'infusion.storm.dash.name': 'Blitzschritt',
  'infusion.slot.primary': 'Dein Primärangriff',
  'infusion.slot.secondary': 'Deine Sekundärfähigkeit',
  'infusion.slot.dash': 'Dein Dash',
  'infusion.desc': '{ability} verursacht {status} (Stärke ×{v}). Ersetzt eine andere Infusion auf derselben Fähigkeit.',

  'boon.keen_edge.name': 'Scharfe Klinge',
  'boon.keen_edge.desc': 'Primärangriffe verursachen +{v} % Schaden.',
  'boon.heavy_hand.name': 'Schwere Hand',
  'boon.heavy_hand.desc': 'Deine Sekundärfähigkeit verursacht +{v} % Schaden.',
  'boon.swift_strikes.name': 'Flinke Hiebe',
  'boon.swift_strikes.desc': 'Primärangriffe sind {v} % schneller.',
  'boon.deadeye.name': 'Adlerauge',
  'boon.deadeye.desc': '+{v} % Chance auf einen kritischen Treffer mit doppeltem Schaden.',
  'boon.executioner.name': 'Henker',
  'boon.executioner.desc': '+{v} % Schaden gegen Gegner unter {threshold} % Leben.',
  'boon.iron_heart.name': 'Eisenherz',
  'boon.iron_heart.desc': '+{v} maximales Leben (und heilt dich um diesen Wert).',
  'boon.barrier.name': 'Barriere',
  'boon.barrier.desc': 'Du erhältst einen Schild von {v} Punkten, der sich nach {recharge} s ohne Schaden wieder auflädt.',
  'boon.leech.name': 'Lebensraub',
  'boon.leech.desc': 'Heilt dich um {v} Leben, wenn du einen Gegner erschlägst.',
  'boon.last_stand.name': 'Letztes Gefecht',
  'boon.last_stand.desc': 'Einmal pro Kammer überlebst du einen tödlichen Treffer mit 1 Leben und bist {invuln} s unverwundbar.',
  'boon.fleet_foot.name': 'Leichtfuß',
  'boon.fleet_foot.desc': '+{v} % Bewegungstempo.',
  'boon.quick_step.name': 'Schnellschritt',
  'boon.quick_step.desc': 'Dein Dash lädt {v} % schneller auf.',
  'boon.spare_step.name': 'Reserveschritt',
  'boon.spare_step.desc': '+1 Dash-Ladung.',
  'boon.quick_wits.name': 'Wacher Geist',
  'boon.quick_wits.desc': 'Abklingzeit der Sekundärfähigkeit um {v} % verkürzt.',
  'boon.wildfire.name': 'Lauffeuer',
  'boon.wildfire.desc': 'Brand verursacht +{v} % Schaden.',
  'boon.deep_frost.name': 'Tiefer Frost',
  'boon.deep_frost.desc': 'Kälte verlangsamt {v} % stärker, und unterkühlte Gegner verursachen {v} % weniger Schaden.',
  'boon.overcharge.name': 'Überladung',
  'boon.overcharge.desc': 'Geschockte Gegner erleiden weitere +{v} % Schaden.',
  'boon.amplifier.name': 'Verstärker',
  'boon.amplifier.desc': 'Resonanz-Explosionen verursachen +{v} % Schaden.',
  'boon.wide_resonance.name': 'Weite Resonanz',
  'boon.wide_resonance.desc': 'Resonanz-Explosionen sind {v} % größer.',
  'boon.aftershock.name': 'Nachbeben',
  'boon.aftershock.desc': 'Eine Resonanz erstattet dir eine Dash-Ladung und {v} % deiner Sekundär-Abklingzeit.',
  'boon.echo.name': 'Echo',
  'boon.echo.desc': 'Resonanz explodiert mit {v} % Chance ein zweites Mal.',
  'boon.kindred_flame.name': 'Gefährtenflamme',
  'boon.kindred_flame.desc': 'Du und Verbündete im Umkreis von {radius} m verursacht +{v} % Schaden.',
  'boon.shared_vigor.name': 'Geteilte Kraft',
  'boon.shared_vigor.desc': 'Deine Resonanz-Explosionen heilen jeden Helden um {v}.',
  'boon.lifeline.name': 'Rettungsleine',
  'boon.lifeline.desc': 'Du belebst Verbündete {v} % schneller wieder; sie kehren mit {v} % mehr Leben zurück.',
  'boon.oathbond.name': 'Eidbund',
  'boon.oathbond.desc': 'Fällt ein Verbündeter (oder sinkst du unter {threshold} % Leben), erhältst du {duration} s lang +{v} % Schaden und Tempo.',

  'door.boon.name': 'Boon',
  'door.boon.desc': 'Wähle 1 von {c} Boons',
  'door.blessing.name': 'Segen',
  'door.blessing.desc': 'Heilt die Gruppe um {v} % + Auswahl',
  'door.cursed.name': 'Verflucht',
  'door.cursed.desc': 'Gestärkte Gegner · {n} Boons, einer selten',
  'door.boss.name': 'Endboss',
  'door.boss.desc': '{boss} wartet',

  'oath.label': 'Eid',
  'oath.badge': 'Eid {n}',
  'oath.0.name': 'Ohne Eid',
  'oath.1.name': 'Eid des Eisens',
  'oath.2.name': 'Eid der Asche',
  'oath.3.name': 'Eid der Letzten Glocke',
  'oath.0.desc': 'Der normale Abstieg. Keine Modifikatoren.',
  'oath.desc': 'Gegner: +{hp} % Leben, +{dmg} % Schaden, +{spd} % Tempo.',
  'oath.locked': 'Gewinne einen Run mit Eid {n}, um ihn freizuschalten.',

  'chamber.combat': 'Kampf',
  'chamber.elite': 'Elite',
  'chamber.boss': 'Boss',

  'lobby.title': 'Versammlungshalle',
  'lobby.code': 'Sitzungscode',
  'lobby.copyCode': 'Code kopieren',
  'lobby.copyLink': 'Einladungslink kopieren',
  'lobby.slotEmpty': 'Freier Platz',
  'lobby.slotEmptyHint': 'Teile den Code, um jemanden einzuladen',
  'lobby.host': 'Host',
  'lobby.ready': 'Bereit',
  'lobby.notReady': 'Nicht bereit',
  'lobby.disconnected': 'Getrennt',
  'lobby.yourClass': 'Deine Klasse',
  'lobby.readyUp': 'Bereit',
  'lobby.unready': 'Nicht bereit',
  'lobby.start': 'Run starten',
  'lobby.waitingHost': 'Warte, bis der Host startet …',
  'lobby.reason.selfNotReady': 'Mach dich bereit, um zu starten.',
  'lobby.reason.othersNotReady': 'Warte auf {names}.',
  'lobby.reason.go': 'Alle sind bereit. Läute die Glocke!',
  'lobby.oathHostOnly': 'Der Host wählt den Eid.',
  'lobby.leaveTitle': 'Sitzung verlassen?',
  'lobby.leaveBody': 'Du kehrst ins Hauptmenü zurück.',

  'hud.wave': 'Welle {n}/{m}',
  'hud.enemies.one': 'Noch 1 Gegner',
  'hud.enemies.many': 'Noch {n} Gegner',
  'hud.phase.draft': 'Kammer geräumt',
  'hud.phase.doors': 'Wählt euren Weg',
  'hud.chamber': 'Kammer {n}/{m}',
  'hud.entered.cursed': 'Verflucht',
  'hud.entered.blessing': 'Gesegnet',
  'hud.key.primary': 'LMB',
  'hud.key.secondary': 'RMB',
  'hud.key.dash': 'Leertaste',
  'hud.ping': '{n} ms',
  'hud.reconnecting': 'Verbindung verloren – verbinde neu …',
  'hud.downed': 'Am Boden',
  'hud.dead': 'Gefallen',
  'hud.disconnected': 'Getrennt',
  'hud.prompt.doors': 'Stellt euch gemeinsam in einen Durchgang, um euren Weg zu wählen',
  'hud.prompt.downed': 'Du liegst am Boden – ein Verbündeter kann dich wiederbeleben',
  'hud.prompt.beingRevived': 'Ein Verbündeter belebt dich wieder …',
  'hud.prompt.downedSolo': 'Du liegst am Boden',
  'hud.prompt.secondWind.one': 'Zweiter Atem: noch 1',
  'hud.prompt.secondWind.many': 'Zweiter Atem: noch {n}',
  'hud.prompt.secondWind.none': 'Kein Zweiter Atem mehr',
  'hud.prompt.reviveHint': 'Stell dich zu {name}, um wiederzubeleben',
  'hud.prompt.reviving': '{name} wird wiederbelebt …',
  'hud.secondWind': 'Zweiter Atem',

  'toast.wave': 'Welle {n}',
  'toast.waveSub': 'von {m}',
  'toast.waveFinal': 'Letzte Welle',
  'toast.chamberClear': 'Kammer geräumt',
  'toast.chamberClearSub': 'Alle stehen wieder – wählt einen Boon',
  'toast.bossPhase': '{name} – Phase {n}',
  'toast.bossPhaseSub': 'Die Toten folgen seinem Zorn',
  'toast.boon': '{name} nimmt {boon}',
  'toast.boonLevel': '{name} bringt {boon} auf Stufe {n}',
  'toast.down': '{name} liegt am Boden!',
  'toast.revived': '{by} hat {name} wiederbelebt',
  'toast.revivedSelf': '{name} steht wieder',
  'toast.door.boon': 'Ein Boon-Pfad',
  'toast.door.boonSub': 'Dahinter wartet eine neue Auswahl',
  'toast.door.blessing': 'Ein gesegneter Pfad',
  'toast.door.blessingSub': 'Räumt die Kammer, und die Gruppe wird geheilt',
  'toast.door.cursed': 'Ein verfluchter Pfad',
  'toast.door.cursedSub': 'Gestärkte Gegner, reichere Beute',
  'toast.door.boss': 'Die letzte Halle',
  'toast.door.bossSub': '{boss} wartet',

  'draft.title': 'Wähle einen Boon',
  'draft.sub': 'Kammer {n} geräumt',
  'draft.subCursed': 'Verfluchte Beute – eine Wahl mehr, ein seltener Boon garantiert',
  'draft.new': 'Neu',
  'draft.upgrade': 'Aufwertung',
  'draft.timer': '{n} s',
  'draft.waiting': 'Warte auf {names} …',
  'draft.waitingTitle': 'Boon gesichert',
  'draft.auto': 'Läuft die Zeit ab, wird ein Boon für dich gewählt.',

  'tab.title': 'Die Gruppe',
  'tab.hero': 'Wächter',
  'tab.damage': 'Schaden',
  'tab.kills': 'Kills',
  'tab.resonances': 'Resonanzen',
  'tab.revives': 'Belebt',
  'tab.downs': 'Gefallen',
  'tab.boons': 'Boons',
  'tab.noBoons': 'Noch keine Boons',
  'tab.yourBoons': 'Deine Boons',
  'tab.time': 'Zeit',

  'settings.title': 'Einstellungen',
  'settings.paused': 'Menü',
  'settings.pausedHint': 'Der Run läuft weiter, solange dieses Menü offen ist.',
  'settings.audio': 'Audio',
  'settings.master': 'Gesamtlautstärke',
  'settings.music': 'Musik',
  'settings.sfx': 'Effekte',
  'settings.video': 'Anzeige',
  'settings.quality': 'Qualität',
  'settings.quality.low': 'Niedrig',
  'settings.quality.medium': 'Mittel',
  'settings.quality.high': 'Hoch',
  'settings.shake': 'Bildschirmwackeln',
  'settings.zoom': 'Kameraabstand',
  'settings.damageNumbers': 'Schadenszahlen',
  'settings.language': 'Sprache',
  'settings.controls': 'Steuerung',
  'settings.resume': 'Weiter',
  'settings.leave': 'Sitzung verlassen',
  'settings.leaveTitle': 'Sitzung verlassen?',
  'settings.leaveBody': 'Deine Gruppe kämpft ohne dich weiter. Solange dein Platz frei gehalten wird, kannst du mit dem Code zurückkehren.',
  'settings.leaveConfirm': 'Sitzung verlassen',

  'controls.move': 'Bewegen',
  'controls.aim': 'Zielen',
  'controls.primary': 'Primärangriff (Kombo)',
  'controls.secondary': 'Sekundärfähigkeit',
  'controls.dash': 'Dash (unverwundbar)',
  'controls.revive': 'Neben einem Verbündeten am Boden stehen bleiben, um ihn wiederzubeleben',
  'controls.scoreboard': 'Übersicht und Boons (halten)',
  'controls.menu': 'Menü',
  'controls.pick': 'Boon wählen',
  'controls.mouse': 'Maus',

  'howto.title': 'Spielanleitung',
  'howto.1': 'Beweg dich mit WASD und ziel mit der Maus. Mit der Leertaste machst du einen Dash – dabei bist du unverwundbar.',
  'howto.2': 'Linksklick reiht Primärangriffe zur Kombo, Rechtsklick löst deine Sekundärfähigkeit aus (mit Abklingzeit).',
  'howto.3': 'Infusions-Boons geben einer Fähigkeit ein Element: Glut verbrennt, Reif unterkühlt, Sturm schockt, Umbra zehrt.',
  'howto.4': 'Resonanz: Triff einen markierten Gegner mit einem anderen Element, und er zerbirst und verteilt das neue Element.',
  'howto.5': 'Stell dich zu gefallenen Verbündeten, um sie wiederzubeleben. Nach jeder Kammer: Boon wählen, dann gemeinsam eine Tür.',

  'summary.victory': 'Sieg',
  'summary.victorySub': '{boss} ist gefallen. Die Letzte Glocke läutet weiter.',
  'summary.defeat': 'Niederlage',
  'summary.defeatSub': 'Das Glimmergrave behält seine Toten. Fürs Erste.',
  'summary.chamber': 'Erreichte Kammer',
  'summary.chamberValue': '{n} von {m}',
  'summary.time': 'Zeit',
  'summary.oath': 'Eid',
  'summary.mvp': 'Bestwert der Gruppe',
  'summary.unlocked': 'Neuer Eid freigeschaltet: {name}',
  'summary.unlockedHint': 'Hoste einen Run, um ihn zu schwören.',
  'summary.toLobby': 'Zurück zur Lobby',
  'summary.waitingHost': 'Warte auf den Host …',

  'error.title': 'Da ist etwas schiefgelaufen',
  'error.bad_version': 'Dein Spiel ist veraltet. Lade die Seite neu, um zu aktualisieren.',
  'error.room_not_found': 'Keine Sitzung mit diesem Code.',
  'error.room_full': 'Diese Sitzung ist voll.',
  'error.run_in_progress': 'Diese Gruppe ist schon in der Gruft. Warte, bis sie in die Lobby zurückkehrt.',
  'error.invalid_name': 'Dieser Name geht nicht. Such dir einen anderen aus.',
  'error.invalid_message': 'Der Server hat das nicht verstanden. Versuch es bitte noch einmal.',
  'error.rate_limited': 'Zu viele Aktionen auf einmal. Mach kurz langsamer.',
  'error.not_host': 'Das kann nur der Host.',
  'error.not_ready': 'Noch sind nicht alle bereit.',
  'error.session_expired': 'Dein Platz in dieser Sitzung ist abgelaufen.',
  'error.server_full': 'Der Server ist gerade voll. Versuch es in ein paar Minuten noch einmal.',
  'error.timeout': 'Der Server hat nichts mehr von dir gehört. Du wurdest getrennt.',
  'error.unreachable': 'Der Server ist nicht erreichbar. Prüf deine Verbindung und versuch es noch einmal.',
  'error.connection_lost': 'Die Verbindung zum Server ist abgebrochen.',
  'error.reload': 'Neu laden',
};

const TABLES: Record<Lang, Record<I18nKey, string>> = { en: EN, de: DE };

export const LANGS: readonly Lang[] = ['en', 'de'];
export const LANG_LABEL: Record<Lang, string> = { en: 'English', de: 'Deutsch' };

const LOCALE: Record<Lang, string> = { en: 'en-US', de: 'de-DE' };

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang === 'de' ? 'de' : 'en';
}

export function getLang(): Lang {
  return current;
}

export type Params = Record<string, string | number>;

function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translates into an explicit language. */
export function tl(lang: Lang, key: I18nKey, params?: Params): string {
  return fill(TABLES[lang][key] ?? EN[key] ?? key, params);
}

/** Translates into the current UI language. */
export function t(key: I18nKey, params?: Params): string {
  return tl(current, key, params);
}

export function hasKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

const DATA: Record<Lang, Readonly<Record<string, string>>> = { en: { ...EN_DATA, ...EN4_DATA }, de: { ...DE_DATA, ...DE4_DATA } };
const own = (table: object, key: string): string | undefined =>
  (Object.prototype.hasOwnProperty.call(table, key) ? (table as Record<string, string>)[key] : undefined);

/** The text of a key in exactly this language (no fallback to English), or null. Used by the coverage check. */
export function textIn(lang: Lang, key: string): string | null {
  return own(TABLES[lang], key) ?? own(DATA[lang], key) ?? null;
}

/**
 * Translates a key that is built from a data id (`talent.<id>.name`, `relic.<id>.body`, ...). Falls back to
 * English, then to `fallback` (or the key itself), so a new table row never breaks the UI.
 */
export function tx(key: string, params?: Params, fallback?: string): string {
  return fill(textIn(current, key) ?? textIn('en', key) ?? fallback ?? key, params);
}

/** Integer with locale grouping (12,480 / 12.480). */
export function formatInt(n: number, lang: Lang = current): string {
  return Math.round(n).toLocaleString(LOCALE[lang]);
}

/** m:ss (or h:mm:ss) for run timers. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "A, B and C" in the given language. */
export function formatList(items: string[], lang: Lang = current): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${tl(lang, 'common.and')} ${items[items.length - 1]}`;
}

const PERCENT_PLACEHOLDER = /\{v\}\s?%/;
const PERCENT_SCALE = 100;
const DECIMAL_SEPARATOR: Record<Lang, string> = { en: '.', de: ',' };

/** Fractions are shown as whole percentages when the reference text says "{v}%"; everything else is flat. */
function boonValue(def: BoonDef, level: number, lang: Lang): string {
  const index = Math.min(Math.max(1, Math.floor(level)), def.values.length) - 1;
  const raw = def.values[index] ?? 0;
  if (PERCENT_PLACEHOLDER.test(def.summary)) return String(Math.round(raw * PERCENT_SCALE));
  const flat = Number.isInteger(raw) ? String(raw) : String(Math.round(raw * PERCENT_SCALE) / PERCENT_SCALE);
  return flat.replace('.', DECIMAL_SEPARATOR[lang]);
}

/** Tuning values quoted inside boon descriptions, so the text follows the balance tables. */
const BOON_TEXT_PARAMS: Params = {
  threshold: Math.round(BOON_TUNING.EXECUTE_THRESHOLD * PERCENT_SCALE),
  recharge: BOON_TUNING.BARRIER_RECHARGE_DELAY,
  invuln: BOON_TUNING.LAST_STAND_INVULNERABILITY,
  radius: BOON_TUNING.KINDRED_RADIUS,
  duration: BOON_TUNING.OATHBOND_DURATION,
};

export interface BoonText {
  name: string;
  desc: string;
}

/**
 * Display name + description of a boon at a level, e.g. formatBoon('keen_edge', 2, 'en')
 * -> { name: 'Keen Edge', desc: 'Primary attacks deal +24% damage.' }. Unknown ids fall back to the id.
 */
export function formatBoon(id: string, level: number, lang: Lang = current): BoonText {
  const def = BOON_BY_ID.get(id);
  if (!def) return { name: id, desc: '' };
  const v = boonValue(def, level, lang);
  if (def.category === 'infusion' && def.element && def.slot) {
    return {
      name: tl(lang, `infusion.${def.element}.${def.slot}.name`),
      desc: tl(lang, 'infusion.desc', {
        ability: tl(lang, `infusion.slot.${def.slot}`),
        status: tl(lang, `status.${def.element}.name`),
        v,
      }),
    };
  }
  const nameKey = `boon.${id}.name`;
  const desc = textIn(lang, `boon.${id}.desc`) ?? textIn('en', `boon.${id}.desc`) ?? def.summary;
  return {
    name: hasKey(nameKey) ? tl(lang, nameKey) : id,
    desc: fill(desc, { v, ...BOON_TEXT_PARAMS }),
  };
}

export function maxBoonLevel(id: string): number {
  return BOON_BY_ID.get(id)?.values.length ?? 1;
}

/** Values quoted in the door legend: {v} blessing heal %, {n} cursed draft size, {c} normal draft size. */
export const DOOR_TEXT_PARAMS: Params = {
  v: Math.round(BOON_TUNING.BLESSING_HEAL_FRACTION * PERCENT_SCALE),
  n: BOON_TUNING.CURSED_DRAFT_CHOICES,
  c: RUN.DRAFT_CHOICES,
};

const ROMAN_DIGITS: readonly [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];
const ROMAN_MAX = 3999;

/** Roman numeral for ranks, tiers, depths and Oath levels (0 stays "0", large numbers stay arabic). */
export function roman(n: number): string {
  let rest = Math.floor(n);
  if (!(rest > 0) || rest > ROMAN_MAX) return String(Number.isFinite(rest) ? rest : 0);
  let out = '';
  for (const [value, digit] of ROMAN_DIGITS) while (rest >= value) { out += digit; rest -= value; }
  return out;
}

/** 12.4 / 12,4 — at most one decimal, none when it is a whole number. */
export function formatNum(n: number, lang: Lang = current): string {
  return n.toLocaleString(LOCALE[lang], { maximumFractionDigits: 1 });
}

/** 1,234 below ten thousand, then 12.3K / 4.5M (Mio. in German) for the big lifetime counters. */
export function formatCompact(n: number, lang: Lang = current): string {
  const COMPACT_FROM = 10000;
  if (Math.abs(n) < COMPACT_FROM) return formatInt(n, lang);
  return n.toLocaleString(LOCALE[lang], { notation: 'compact', maximumFractionDigits: 1 });
}
