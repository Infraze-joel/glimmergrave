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
3. Kammer geräumt → jeder wählt 1 von 3 Boons (33 Stück, bis zu 3 Stufen); gefallene Helden stehen wieder auf.
4. Zwei Ausgänge öffnen sich (Boon / Blessing / Cursed). Die Gruppe entscheidet, indem sie sich gemeinsam in
   einen Durchgang stellt.
5. Acht Kammern in drei Akten: Kampf ×3, Elite (Crypt Champion), Kampf ×2, Herold (schwächere Form eines
   Bosses, der in diesem Run nicht der Endboss ist), Endboss. Der Endboss wechselt pro Run: Bone Regent,
   Hex Matron oder Ossuary Stalker, alle mit drei Phasen.
6. Akt 1 spielt in der Gruft, Akt 2 und 3 in den überfluteten Katakomben und der Glutschmiede (Reihenfolge
   wechselt). Jedes Biom hat eigene Raumformen, Hindernisse und Bodenfallen (Stacheln, Frostnebel,
   Feuerdüsen), die Helden und Gegner treffen.
7. Sieg oder Niederlage → Auswertung mit verdientem Glimmer → Rüstkammer → nächster Run. Ein Sieg schaltet
   die nächste Oath-Stufe (Schwierigkeit 0–3) frei.

**Dauerhafter Fortschritt:** Glimmer gibt es für jeden Run. In der Rüstkammer kauft man neun Upgrades in
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
| Leertaste / Shift | Dash (kurz unverwundbar) |
| neben gefallenem Verbündeten stehen (3 s) | Wiederbeleben |
| Tab (halten) | Übersicht: Statistik und Boons |
| 1–4 | Boon-Karte wählen |
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
- **Audio wurde nie angehört**, nur technisch geprüft (keine Fehler, Pegel per Offline-Rendering).
- **Sieg im Browser nicht durchgespielt.** Bots gewinnen Runs in den Server-Tests; die Browser-Sitzungen
  endeten mit Niederlagen (Kammer 6 und Boss). Die Sieg-Auswertung ist nur mit Beispieldaten geprüft.
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
| Unit- und Integrationstests (`npm test`) | 185 Tests in 14 Dateien bestanden (auch unter Node 24) |
| – Protokoll, Bewegung, Fähigkeiten, Status/Resonance, Boons, Draft, Gegner, Telegraph-Fairness, Director, Determinismus | enthalten |
| – Server mit echten WebSocket-Clients: Erstellen/Beitreten/Wiederbeitritt, ungültiger Code, voller Raum, falsche Version, kaputte/zu große Nachrichten, Ratenlimit, Host-Wechsel, Abbruch im Run, Ablauf der Frist, Rückkehr zur Lobby | enthalten |
| – Zwei Bots spielen einen ganzen Run, auch mit 150 ± 50 ms Latenz | bestanden |
| Browser-Tests gegen den Produktions-Build (`npm run test:e2e`), Seite und WebSocket auf derselben Adresse | 12 Tests bestanden |
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

Gemessen in einem 4-Spieler-Kampf in Kammer 6 über 90 s (Chrome headless, 2 CPU-Kerne, ohne GPU):

| Größe | Wert |
|---|---|
| Rechenzeit Hauptthread pro Frame (Logik, Animation, Effekte; ohne GPU-Zeichnen) | Ø 1,75 ms, max. 4,3 ms (Budget bei 60 FPS: 16,6 ms) |
| Gegner gleichzeitig | Ø 27, max. 47 |
| Draw Calls / Dreiecke bei 47 Gegnern | 137 / 245 000 |
| JS-Heap | 34 MB → 38 MB nach 90 s, Spitze 45 MB |
| Netzwerk pro Client | 10,4 kB/s empfangen, 0,4 kB/s gesendet |
| Server: `World.step` (4 Helden, 47 Gegner, 61 Projektile) | Ø 0,12 ms |
| Download | Spielcode 82 kB + three.js 172 kB + CSS 11 kB (gzip); Modelle 4,2 MB (ca. 2,1 MB gzip) |

Bots, Balance bei Oath 0: Solo-Sieg 57 % (40 Runs), 4er-Gruppe 71 % (24 Runs), Sieg nach Ø 9,8 bzw. 10,7
Spielminuten, Bosskampf Ø 76–121 s.

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
