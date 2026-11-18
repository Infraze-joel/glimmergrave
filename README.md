# Glimmergrave

Ein kooperatives 3D-Action-Roguelike für 1–4 Spieler im Browser. Frontend und Multiplayer-Backend laufen
zusammen auf Netlify: die statische Seite plus ein autoritativer WebSocket-Server als **Netlify Server**
(dieselbe Adresse, Pfad `/ws`). Alternativ läuft das Backend als Docker-Container auf einem anderen Host.

> Stand: lokal gebaut und getestet (Details unter [Tests](#13-durchgeführte-tests) und
> [Bekannte Einschränkungen](#12-bekannte-einschränkungen)). Der Betrieb auf Netlify ist mit Netlifys eigenem
> Bundler und lokalem Emulator geprüft, aber noch **nicht** auf Netlify selbst.

## 1. Spielkonzept

Die Wardens of the Last Bell steigen in das Glimmergrave hinab, eine versunkene Gruft, in der der Bone Regent
„Glimmer" (kristallisiertes Seelenlicht) hortet, um ein Heer von Untoten zu erheben. Kern des Spiels ist
**Resonance**: Fähigkeiten lassen sich mit Ember, Rime oder Storm aufladen. Trifft ein Element einen Gegner,
der bereits ein *anderes* trägt, entlädt sich das in einer Explosion, die das neue Element auf umstehende
Gegner überträgt. Allein baut man sich Kombinationen über mehrere Fähigkeiten, in der Gruppe ergänzen sich die
Spieler. Jeder Run führt durch drei Biome zu einem von drei Endbossen, und mit dem verdienten Glimmer werden
die Helden dauerhaft stärker. Vollständiges Konzept: [`docs/gameplan.md`](docs/gameplan.md).

## 2. Gameplay-Loop

1. Host erstellt eine Sitzung, Mitspieler treten mit einem 5-stelligen Code bei, alle wählen eine Klasse.
2. Kammer betreten → Wellen von Untoten → bewegen, ausweichen, angreifen, Resonance auslösen.
3. Kammer geräumt → jeder wählt 1 von 3 Boons (80 Stück, bis zu 3 Stufen); gefallene Helden stehen wieder auf.
4. Zwei Ausgänge öffnen sich (Boon / Blessing / Cursed). Die Gruppe entscheidet, indem sie sich gemeinsam in
   einen Durchgang stellt.
5. Acht Kammern in drei Akten: Kampf ×3, Elite (Crypt Champion), Kampf ×2, Herold (schwächere Form eines
   Bosses, der in diesem Run nicht der Endboss ist), Endboss. Der Endboss wechselt pro Run: Bone Regent,
   Hex Matron oder Ossuary Stalker, alle mit drei Phasen.
6. Akt 1 spielt in der Gruft, Akt 2 und 3 in den überfluteten Katakomben und der Glutschmiede (Reihenfolge
   wechselt). Jedes Biom hat eigene Raumformen, Hindernisse und Bodenfallen (Stacheln, Frostnebel,
   Feuerdüsen), die Helden und Gegner treffen.
7. Nach dem Endboss entscheidet die Gruppe an zwei Türen: **aufsteigen** (Sieg sichern) oder **tiefer
   hinabsteigen**. Jede Tiefe beginnt die acht Kammern neu, mit deutlich stärkeren Gegnern, Elite-Eigenschaften
   (flink, gepanzert, explosiv, vampirisch), einem anderen Endboss und höheren Belohnungen. Wer tiefer fällt,
   behält den Sieg.
8. Auswertung mit Glimmer, Klassen-Erfahrung und Relikt-Splittern → Fortschritt ausgeben → nächster Run.
   Ein Sieg schaltet die nächste Oath-Stufe frei (Schwierigkeit 0–20).

**Update 3 – „The Endless Descent":**

- **Sieben Klassen:** Knight, Barbarian, Mage, Rogue sowie Templar (Zweihänder, heilt die Gruppe), Spellblade
  (Nahkampf-Kombo mit Fernwelle, blinzelt durch Gegner) und Shade (Doppeldolche, Rückenstiche, markiert Ziele).
- **Drei Fähigkeiten pro Klasse:** Primärkette, Sekundärfähigkeit (mit freischaltbarer Alternative) und ein
  Ultimate auf Q, das sich durch Kämpfen auflädt.
- **Vier Elemente, sechs Reaktionen:** neu ist Umbra (Zustand Wither). Jedes Elementpaar löst eine eigene
  Reaktion aus: Shatter, Conflagration, Superconduct, Soulfire, Entomb, Void Arc.
- **Synergien:** Set-Boni für gesammelte Boons einer Art, Klassen-Boons, sechs legendäre Duo-Boons.
- **Fortschritt ohne Ende** (Menüpunkt „Fortschritt"): Rüstkammer (18 Upgrades), Aufstieg (endlose Ränge mit
  steigenden Preisen), Meisterschaft (Klassenstufen ohne Obergrenze, 42 Talente), Reliquiar (20 Relikte, Rang
  1–10 über Splitter von Bossen und Elitegegnern, 1–3 Plätze) und Chronik (16 Taten mit Glimmer-Belohnung).
- **Zielcursor:** eigenes Fadenkreuz pro Klasse, gefärbt nach dem Element des Primärangriffs, mit
  Klick-Rückmeldung und Funkenkranz bei bereitem Ultimate (Größe in den Einstellungen).

**Dauerhafter Fortschritt (Stand Update 2, erweitert durch Update 3):** Glimmer gibt es für jeden Run. In der Rüstkammer kauft man Upgrades in
Stufen (Leben, Schaden, Tempo, Cooldowns, Neuwürfe, Start-Infusion, robustere Wiederbelebung, mehr Glimmer).
Ohne Upgrades gewinnt ein geübter Solo-Spieler etwa jeden dritten Run, voll ausgebaut etwa vier von fünf
(mit Bots gemessen).

**Anpassung:** Stofffarbe, Kopfbedeckung, Umhang und drei Ausrüstungsvarianten pro Klasse, rein optisch,
mit 3D-Vorschau.

**Einstieg:** Ein geführtes Training (etwa drei Minuten) erklärt Bewegung, Dash, die drei Elemente, Resonance,
Fallen, Boon-Auswahl und Türen. Danach helfen die Element-Leiste im HUD, einmalige Hinweise und der Kodex.

Ein Run dauert etwa 10–15 Minuten.

## 3. Steuerung

| Eingabe | Aktion |
|---|---|
| W A S D / Pfeiltasten | Bewegen |
| Maus | Zielen (der Held schaut immer zum Mauszeiger) |
| Linke Maustaste (halten) | Primärangriff, Kombo-Kette |
| Rechte Maustaste / F | Sekundärfähigkeit (Cooldown) |
| Q / mittlere Maustaste | Ultimate (braucht volle Ladung) |
| Leertaste / Shift | Dash (kurz unverwundbar) |
| neben gefallenem Verbündeten stehen (3 s) | Wiederbeleben |
| Tab (halten) | Übersicht: Statistik und Boons |
| 1–5 | Boon-Karte wählen |
| R | Boon-Auswahl neu würfeln (mit dem Upgrade „Einsicht") |
| Esc | Pause-/Einstellungsmenü |

## 4. Technische Architektur

```
shared/   reines TypeScript für Client UND Server: Typen, Protokoll, Balance-Tabellen, Simulation
server/   Node 22 + ws: Räume, Sitzungen, Validierung, 30-Hz-Tick (nutzt shared/sim)
client/   Vite + Three.js: net/ (Verbindung, Prediction, Interpolation), render/ (3D), game/ (Loop, Eingabe),
          ui/ (DOM-Oberflächen, EN/DE), audio/ (prozedural), core/ (EventBus, GameState, Settings)
netlify/  server/index.mjs: Startdatei für Netlify Server (Region, Größe, Instanzen, Pfad)
tools/    Asset-Pipeline       tests/e2e/  Browser-Tests       docs/  Konzept, Technik, Entscheidungen
```

Client-Module sprechen nur über `core/EventBus.ts` und `core/GameState.ts` miteinander. Alle Balance-Werte
liegen in `shared/src/data/*` und `shared/src/constants.ts`. Mehr: [`docs/tech.md`](docs/tech.md),
[`docs/architectural-decisions/0001-engine-and-stack.md`](docs/architectural-decisions/0001-engine-and-stack.md).

## 5. Multiplayer-Architektur

- **Autoritativer Server.** Clients senden ausschließlich Eingaben (11 Byte, 30 Hz) und Absichten (Klasse,
  bereit, Boon-Wahl). Positionen, Schaden, Cooldowns und Beute entscheidet allein der Server; diese Werte
  kommen im Protokoll vom Client gar nicht vor.
- **Simulation** mit festem Zeitschritt (30 Hz) und Seed-Zufall in `shared/src/sim`.
- **Snapshots** binär und quantisiert, 15 Hz (im dichten Kampf gemessen ca. 10 kB/s pro Client),
  Ereignisse für Effekte/Sound als JSON gebündelt.
- **Eigener Held:** Client-Vorhersage mit demselben Bewegungscode wie der Server
  (`shared/src/sim/movement.ts`), Abgleich über die bestätigte Eingabenummer, Korrekturen werden geglättet.
- **Alle anderen Entitäten:** Interpolation 120 ms in der Vergangenheit.
- **Ausrüstung und Upgrades:** Der Client schickt Aussehen und Upgrade-Stufen mit; der Server begrenzt jede
  Stufe auf ihr Maximum. Glimmer-Belohnungen berechnet der Server, gespeichert wird im Browser.
- **Sitzungen:** Codes ohne verwechselbare Zeichen, max. 4 Spieler, Beitritt nur in der Lobby.
  Verbindungsabbruch: Slot bleibt 90 s reserviert, Wiederbeitritt per geheimem Token (auch nach Neuladen der
  Seite, automatisch). Host-Wechsel, wenn der Host geht.
- **Schutz:** strikte Validierung jeder Nachricht, Größen- und Ratenlimit, Versionsprüfung, Origin-Prüfung,
  Heartbeat/Timeouts, Raumlimit.

**Hosting:** Der Client verbindet sich standardmäßig mit `wss://<eigene Adresse>/ws/game`. Dort läuft der
Spielserver als Netlify Server (seit November 2026, Early Access): ein dauerhaft laufender Node-Prozess, der
mit der Seite zusammen deployt wird. Mit `VITE_SERVER_URL` zeigt der Client stattdessen auf ein externes
Backend. Begründung: [`docs/architectural-decisions/0002-netlify-server.md`](docs/architectural-decisions/0002-netlify-server.md).

## 6. Lokale Installation und Start

Voraussetzung: Node.js ≥ 22 (Netlify Server verlangt Node 24; damit sind Build und Tests ebenfalls geprüft).

```bash
npm ci
npm run dev          # Server auf :8787 und Client auf http://localhost:5173
```

Weitere Befehle: `npm run typecheck`, `npm run lint`, `npm test` (Unit + Integration),
`npm run test:e2e` (Browser-Tests, braucht Chrome; `CHROME_BIN` setzt den Pfad), `npm run build`.

Im Dev-Modus gibt es `?autopilot` (ein Skript spielt den eigenen Helden), `?showcase` (3D-Schaukasten) und
`?uidemo` (alle Oberflächen mit Beispieldaten).

## 7. Netlify-Deployment (Frontend und Backend zusammen)

`netlify.toml` und `netlify/server/index.mjs` sind fertig konfiguriert.

1. Repository bei Netlify als neue Site verbinden (Basisverzeichnis: Repo-Wurzel). Mehr ist nicht einzustellen:
   keine Umgebungsvariablen, kein zweiter Dienst.
2. Deploy auslösen. Netlify führt `npm run build:netlify` aus (Client-Build plus Server-Bundle) und startet den
   Spielserver als Netlify Server in Frankfurt (`fra`), mit höchstens einer Instanz.
3. Kontrolle: `https://<site>/ws/health` liefert `{"ok":true,…}`. Danach im Spiel **Host game**.

Was Netlify Server für das Spiel bedeutet (Stand Early Access, laut Netlify-Dokumentation):

- Verbindungen werden nach 30 Minuten getrennt (2 Stunden ab Pro). Der Client tritt automatisch wieder bei;
  das ist als kurzer Hänger spürbar.
- Eine Instanz wird nach 8 Stunden ersetzt, auch wenn gerade gespielt wird. Laufende Runs gehen dabei verloren.
- Ohne Verbindungen schaltet die Instanz nach 5 Minuten ab; der erste Spieler danach wartet auf den Kaltstart.
- Jeder Deploy ersetzt auch das Backend und beendet laufende Sitzungen.
- Kostenlos während Early Access; Preise danach sind noch nicht bekannt.
- Einstellungen (Region, Größe, Instanzen, Pfad) stehen in `netlify/server/index.mjs`. `scale.max` muss 1
  bleiben, weil Räume im Arbeitsspeicher eines Prozesses liegen.
- Es gibt bewusst keine Weiterleitung aller Pfade auf `index.html` (sie würde `/ws/*` abfangen). Unbekannte
  Pfade bekommen `404.html`, das zur Startseite zurückführt und `?join=` erhält.

Lokal mit Netlifys Werkzeugen: `npm run build:netlify`, dann `netlify dev` (CLI ≥ 27.17, Node ≥ 24).

## 8. Backend-Deployment als Container (Alternative)

Wer das Backend nicht auf Netlify betreiben will, nimmt den Container (`Dockerfile` im Repo-Stamm, keine Datenbank):

```bash
docker build -t glimmergrave-server .
docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://deine-site.netlify.app glimmergrave-server
```

Geeignet ist jeder Host mit dauerhaft laufendem Container, WebSockets und TLS (Fly.io, Render, Railway, eigener
Server oder Cluster hinter einem Reverse Proxy):

- TLS am Eingang, damit die Adresse `wss://` ist; WebSocket-Upgrade und Leerlauf-Timeout ≥ 60 s zulassen.
- **Eine** Instanz. Health-Check: `GET /health`.
- Im Frontend-Build `VITE_SERVER_URL=wss://<backend>` setzen und im Backend `ALLOWED_ORIGINS` auf die Adresse
  der Seite. In `netlify.toml` dann den Build-Befehl auf `npm run build:client` stellen und `netlify/server/`
  entfernen, damit Netlify keinen zweiten Server startet.

Ohne Docker: `npm ci && npm run build:server && PORT=8787 node server/dist/server.js`.

## 9. Umgebungsvariablen

| Variable | Wo | Bedeutung | Standard |
|---|---|---|---|
| `VITE_SERVER_URL` | Frontend-Build | Adresse eines externen Backends (`wss://…`). Für Netlify Server **nicht** setzen. | Dev: `ws://<host>:8787`; Produktion: dieselbe Adresse wie die Seite, Pfad `/ws/game` |
| `PORT` | Backend | Port des Servers (Netlify setzt ihn selbst) | `8787` |
| `ALLOWED_ORIGINS` | Backend | Kommagetrennte erlaubte Browser-Origins, `*` = alle. Seiten vom selben Host sind immer erlaubt. | `*` |
| `MAX_ROOMS` | Backend | Maximale Zahl gleichzeitiger Räume | `200` |
| `DEBUG_START_CHAMBER` | Backend, nur QA | Runs beginnen in dieser Kammer (0–7). Nie in Produktion setzen. | `0` |

Vorlage: [`.env.example`](.env.example). Es gibt keine Geheimnisse im Client oder im Repository.

## 10. Verwendete Technologien

TypeScript 7, Three.js r187 (WebGL), Vite 8, Node.js 22, `ws` 8, esbuild, Vitest 5, puppeteer-core
(nur Tests), ESLint + typescript-eslint, glTF-Transform + meshoptimizer (Asset-Pipeline),
@fontsource/cinzel (Schrift, OFL), Web Audio API.

## 11. Assets und Lizenzen

Alle 3D-Modelle, Texturen und Animationen stammen aus drei **KayKit**-Paketen von Kay Lousberg unter
**CC0 1.0** (frei, auch kommerziell, keine Namensnennung nötig). Soundeffekte stammen aus CC0-Paketen von
Kenney, ergänzt um synthetische Schichten für die Elemente; die Musik wird zur Laufzeit erzeugt. Quellen,
Lizenzen und Pipeline: [`docs/AUDIO.md`](docs/AUDIO.md). Icons und Favicon sind eigene SVGs. Quellen und Pipeline: [`docs/ASSETS.md`](docs/ASSETS.md).
Bibliotheken: MIT (three, ws, vite, …), Cinzel: SIL Open Font License.

## 12. Bekannte Einschränkungen

- **Nicht auf Netlify selbst getestet, kein Test über das Internet.** Geprüft wurde lokal mit unabhängigen
  Browser-Clients und Bot-Clients über echte WebSockets, zusätzlich mit 150 ms künstlicher Latenz. Für Netlify
  Server: Netlifys Bundler nimmt Startdatei und Einstellungen an, und unter Netlifys lokalem Emulator erreichen
  HTTP und WebSocket den Spielserver. Der Emulator wendet aber weder die Pfad-Einstellung noch die Limits an.
- **Netlify Server ist Early Access** (eine Woche alt bei Fertigstellung): Verhalten, Limits und Preise können
  sich ändern. Unsicher ist insbesondere, ob das Server-Bundle erst nach dem Build-Befehl gepackt wird
  (davon hängt ab, ob die erzeugte Datei `game-server.generated.mjs` gefunden wird); falls nicht, schlägt der
  Deploy sichtbar fehl, und die Datei muss eingecheckt werden.
- **Keine echte FPS-Messung.** Die Testumgebung hat keine GPU (Software-Rendering). Gemessen sind
  Rechenzeit pro Frame, Draw Calls, Dreiecke, Speicher und Netzlast, nicht die Bildrate auf echter Hardware.
- **Nur Chrome getestet** (headless). Firefox und Edge sind ungetestet.
- **Audio wurde nie angehört**, nur technisch geprüft (alle 160 Dateien dekodierbar, keine Fehler, Pegel per
  Offline-Rendering). Die Sounds sind nach Dateiname und Messwerten ausgewählt, nicht nach Gehör. Zum Anhören:
  `npm run dev`, dann `http://localhost:5173/?audiodemo` (jeder Sound und jede Musikstimmung auf Knöpfen).
- **Update 3 ist nur von Bots und Tests gespielt.** Die neuen Klassen, Ultimates, Reaktionen und der Abstieg
  sind in der Simulation getestet und in Browser-Sitzungen mit Bots gelaufen; kein Mensch hat sie gespielt.
  Voll ausgebaute Helden gewinnen Tiefe 0 und 1 in den Bot-Läufen immer – ab Tiefe 2 und über Oath 3 ist die
  Balance ungeprüft (nur auf sauberes Ende getestet). Der Knight ist ohne Upgrades die schwächste Klasse
  (ca. 21 % Solo-Siege, Schnitt 35 %). Ultimates laden bei voll ausgebauten Gruppen vermutlich zu schnell.
- **Sichtbarkeit in Update 3:** Umbra und die Rauchwolke heben sich auf dunklem Boden nur schwach ab; die
  Spellblade ähnelt aus der Spielkamera der Mage (Unterschied vor allem Farbe und Waffe). Die schwebende
  Beschriftung einer Reaktion in der 3D-Szene lautet immer „RESONANCE"; den Namen der Reaktion zeigt das HUD.
- **Update 2 ist nur von Bots und Tests gespielt.** Die neuen Bosse, Biome, Fallen, das Training und die
  Upgrade-Balance hat noch kein Mensch gespielt. Aus der Spielkamera sind die neuen Bosse vor allem an
  Kopfschmuck und Waffe zu erkennen.
- **Sieg im Browser von mir nicht durchgespielt.** Bots gewinnen Runs in den Server-Tests; meine
  Browser-Sitzungen endeten mit Niederlagen. Die Sieg-Auswertung ist nur mit Beispieldaten geprüft.
- **Balance** ist ausschließlich mit Bots abgestimmt, nicht mit menschlichen Spielern.
- **Eine Server-Instanz.** Räume liegen im Arbeitsspeicher; ein Neustart (auf Netlify spätestens alle
  8 Stunden und bei jedem Deploy) beendet laufende Sitzungen, mehrere Instanzen bräuchten Routing pro Raumcode.
- **WebSocket/TCP:** bei Paketverlust können kurze Hänger entstehen.
- Kein Beitritt in einen laufenden Run (nur Wiederbeitritt), kein Gamepad, keine Touch-Steuerung.
- **Keine Konten:** Statistik, Glimmer, Upgrades und Aussehen liegen im Browser. Wer den Speicher löscht,
  verliert sie; wer ihn manipuliert, kann sich höchstens voll ausgebaute Upgrades geben (der Server begrenzt
  die Stufen).
- Die visuelle Abnahme der 3D-Darstellung erfolgte anhand von Screenshots bei sehr niedriger Bildrate.

## 13. Durchgeführte Tests

| Prüfung | Ergebnis |
|---|---|
| Frische Installation (`npm ci` in neuem Klon), Typprüfung, Lint | fehlerfrei |
| Unit- und Integrationstests (`npm test`) | 435 Tests in 25 Dateien bestanden |
| – Protokoll, Bewegung, Fähigkeiten, Status/Resonance, Boons, Draft, Gegner, Telegraph-Fairness, Director, Determinismus | enthalten |
| – Server mit echten WebSocket-Clients: Erstellen/Beitreten/Wiederbeitritt, ungültiger Code, voller Raum, falsche Version, kaputte/zu große Nachrichten, Ratenlimit, Host-Wechsel, Abbruch im Run, Ablauf der Frist, Rückkehr zur Lobby | enthalten |
| – Zwei Bots spielen einen ganzen Run, auch mit 150 ± 50 ms Latenz | bestanden |
| Browser-Tests gegen den Produktions-Build (`npm run test:e2e`), Seite und WebSocket auf derselben Adresse | 19 Tests bestanden |
| – Update 3: Spielstand von vor Update 3 behält Glimmer und Upgrades; Meisterschaft schaltet Alternative und Talent frei, der Server begrenzt sie pro Klasse; ein beendeter Run zahlt Glimmer und Erfahrung und verbucht sie | enthalten |
| – Update 3 im Server: jede Klasse, Alternative und jedes Ultimate, Umbra und alle sechs Reaktionen, neue Boons, Sets, Talente, Relikte, Abstieg, Belohnungen, Elite-Eigenschaften | 110 eigene Tests |
| – Modelle und Sounds werden nur mit Inhaltsversion (`?v=…`) geladen; ein Browser mit einer älteren Modelldatei im Cache lädt die neue Version trotzdem (Fehler `missing prop skel_quiver` nach dem ersten Deploy von Update 2, lokal nachgestellt) | enthalten |
| – Update 2: Training startet aus dem Menü und rückt nach dem ersten Schritt vor; Upgrade-Kauf übersteht ein Neuladen; gewähltes Aussehen kommt beim anderen Client an | enthalten |
| – Update 2 im Server: alle drei Bosse und Herolde mit Bots, Telegraph-Fairness, Biom- und Fallen-Regeln, jedes Upgrade, Belohnungen, Neuwürfe, Tutorial (auch mit passivem Spieler) | in den Unit- und Integrationstests enthalten |
| – Start ohne Konsolenfehler mit Netlify-Headern (CSP), `/ws/health`, 404-Seite führt zurück und erhält `?join=` | enthalten |
| – Zwei unabhängige Browser-Clients: Host/Join, Bereit-Status, nur der Host kann starten | enthalten |
| – Bewegung und Kampf synchron zwischen den Clients, 150 ms Latenz, Neuladen → Wiederbeitritt, Verbindungsabbruch, Verlassen | enthalten |
| Ganzer Run im Browser mit 3 Bot-Mitspielern (Dev-Autopilot) | 7:55 min bis Niederlage in Kammer 6, keine Konsolenfehler |
| Bosskampf im Browser, danach Rückkehr zur Lobby | lief, keine Konsolenfehler |
| Produktions-Build | keine `localhost`-Adressen oder absoluten Pfade im Ergebnis |
| Netlifys Bundler (`@netlify/zip-it-and-ship-it`) auf `netlify/server/index.mjs` | angenommen: Region `fra`, Größe `small`, max. 1 Instanz, Route `/ws/*`, Laufzeit Node 24; das Bundle startet und beantwortet `/ws/health` |
| Netlifys lokaler Emulator (`@netlify/dev` 5.2, Node 24) | Startseite, `/ws/health` und ein WebSocket-Beitritt über den Emulator funktionieren |
| Server-Bundle | startet, `/health` antwortet |

Header, 404-Verhalten und die Weiterleitung von `/ws/*` wurden lokal mit `scripts/serve-dist.mjs`
nachgestellt (liest `netlify.toml`), nicht auf Netlify selbst.

## 14. Performance-Ergebnisse

Chrome headless, 2 CPU-Kerne, ohne GPU. Die erste Zeile stammt aus einem 4-Spieler-Kampf vor Update 2 und
wurde danach nicht neu gemessen; die übrigen Werte sind von Update 2.

| Größe | Wert |
|---|---|
| Rechenzeit Hauptthread pro Frame (ohne GPU-Zeichnen), vor Update 2 | Ø 1,75 ms, max. 4,3 ms (Budget bei 60 FPS: 16,6 ms) |
| Draw Calls / Dreiecke im Stresstest (44 Gegner, 55 Projektile, 8 Fallen) | Gruft 133 / 245 000, Katakomben 137 / 261 000, Schmiede 142 / 247 000 |
| Server: `World.step` (4 Helden, 47 Gegner, 61 Projektile, 8 Fallen) | Ø 0,14–0,23 ms |
| Snapshot bei 47 Gegnern | 1243 Byte (15 pro Sekunde) |
| Download (gzip) | Spielcode ca. 150 kB + three.js 172 kB; Modelle 4,9 MB; Sounds 0,6 MB, werden erst nach der ersten Eingabe nachgeladen |

Bots, Balance bei Oath 0 (8 Seeds pro Solo-Klasse, 5 pro Gruppe, je Endboss):

| | Sieg | Ø Dauer Sieg | Bosskampf Ø |
|---|---|---|---|
| Solo ohne Upgrades | 34 % | 11,3 min | 127 s |
| 4er-Gruppe ohne Upgrades | 62 % | 12,2 min | 107 s |
| Solo mit allen Upgrades | 79 % | 9,2 min | 94 s |
| 4er-Gruppe mit allen Upgrades | 100 % | 9,6 min | 81 s |

Die Werte schwanken je nach Seeds um etwa ±6 Prozentpunkte. Eine voll ausgebaute 4er-Gruppe aus Bots verliert
nie; für sie sind die höheren Oath-Stufen gedacht.

## 15. Verifikation mit zwei echten Clients

Lokal (zwei Geräte im selben Netz oder zwei Browserfenster):

1. `npm ci`, dann in zwei Terminals `npm run dev:server` und `cd client && npx vite --host`
   (`--host` macht den Client im Netz erreichbar; für zwei Fenster am selben Rechner genügt `npm run dev`).
2. Gerät A: `http://<IP-von-A>:5173` öffnen, Namen eingeben, **Host game**. Den 5-stelligen Code notieren.
3. Gerät B: dieselbe Adresse öffnen, Code eingeben, **Join**. Beide erscheinen in der Lobby.
4. Beide **Ready**, A startet. Prüfen: Bewegungen und Angriffe des anderen sind sichtbar, Gegner und
   Lebensbalken stimmen überein, Schadenszahlen erscheinen bei beiden.
5. B lädt die Seite neu → B ist nach wenigen Sekunden wieder im selben Run.
6. B schließt den Tab → A sieht B als „disconnected", der Run läuft weiter.

Über das Internet (nach dem Deployment):

1. Auf Netlify deployen, `https://<site>/ws/health` muss `{"ok":true}` liefern.
2. Zwei Personen an verschiedenen Anschlüssen wiederholen die Schritte 2–6 mit der Netlify-Adresse.
   Die Ping-Anzeige oben rechts zeigt die Laufzeit zum Server.
3. Eine Sitzung länger als 30 Minuten offen halten und prüfen, dass der automatische Wiederbeitritt nach der
   Trennung durch Netlify funktioniert.
