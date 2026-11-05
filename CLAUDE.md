# Hex Hockey

3D-Airhockey in Draufsicht für 2–6 Spieler, jeder auf seinem eigenen Handy (auch iPhone). Jeder Spieler hat ein eigenes Tor; die Tore liegen gleichmäßig auf einem Kreis und die Banden verbinden die Torpfosten direkt (keine Ecken; nur bei 2 Spielern knicken sie nach außen, sonst wäre es ein Schlauch). Zwei Modi (Lobby-Einstellung `mode`):
- **Leben** (`lives`): Jedes Gegentor kostet ein Leben; wer keine mehr hat, scheidet aus: sein Tor verschwindet, die übrigen rücken zusammen und das Feld wird kleiner. Der Letzte gewinnt.
- **Zeit** (`time`, `minutes`): Niemand scheidet aus. Punkte = Tore − Gegentore (`points`/`standings` in `physics.js`); nach Ablauf gewinnt der Beste, bei Gleichstand an der Spitze gibt es Verlängerung, bis einer allein vorne liegt.

Am Ende zeigt eine Statistik für jeden Spieler Tore und Gegentore (Torschütze = wer den Puck zuletzt berührt hat; Eigentore zählen nur als Gegentor).

Reines HTML/CSS/JS mit nativen ES-Modulen, kein Build-Schritt (Node ist nicht installiert). Three.js, PeerJS und qrcode-generator kommen per CDN (`index.html`).
Lokal starten: `python3 tools/serve.py` (Port 8010, ohne Browser-Cache; Konfiguration in `.claude/launch.json`).

## Aufbau
- `js/config.js` – alle Konstanten: Farben, Tischmaße, Physik, KI-Stufen, Netzwerk
- `js/arena.js` – Feldgeometrie aus einer Tor-Liste (`evenLayout` → `buildArena`): Kanten mit Normalen nach außen, `goal`-Kanten = Tormund, Spielerzonen als Tortenstück (`planes`) bis `zoneDepth`; `closing` = Tor, das gerade verschwindet
- Nach einem Ausscheiden: `Simulation.morph` verschiebt die Tore über `MORPH_TIME`, Pucks ruhen solange; der Renderer baut den Tisch neu, sobald sich `view.arena` ändert
- `js/physics.js` – Simulation (feste Schrittweite 1/240 s), läuft nur auf dem Host; `snapshot()` für die Mitspieler. Der Puck ist fest: `keepPucksSolid()` schiebt Schläger zurück, statt ihn überlappen zu lassen (auf Mitspieler-Handys macht `keepPucksOutside()` dasselbe für die Anzeige)
- `js/ai.js` – KI-Gegner (verteidigen, hinter den Puck kommen, durchschlagen)
- `js/render.js` – Three.js-Szene; zeichnet einen „View“ (Simulation oder deren Abbild), Kamera dreht sich so, dass das eigene Tor unten ist. Das Sonnenlicht dreht mit, sonst spiegelt die glänzende Fläche je nach Blickrichtung hell
- `js/net.js` – Räume über WebRTC/PeerJS: Peer-ID = `hexhockey-v1-<CODE>`; der öffentliche PeerJS-Server vermittelt nur, die Daten gehen direkt zwischen den Handys
- `js/main.js` – Bildschirme (Start, Lobby, Spiel, Ende), Finger-Eingabe, Hauptschleife
- `js/audio.js` – synthetische Geräusche (WebAudio), erst nach der ersten Berührung aktiv (iPhone)

## Netzwerk-Protokoll
- Mitspieler → Host: `hello {name}`, `in {x, y}` (Fingerziel in Feldkoordinaten), `ping`
- Host → Mitspieler: `lobby`, `start {players, settings, you}`, `s` (Schnappschuss 30×/s: Schläger `m`, Pucks `p`, Leben `l`, Tore/Gegentore `k`, Torlage `g`, Ereignisliste `ev`; im Zeitmodus zusätzlich Restzeit `c` und Verlängerung `o`), `busy`, `full`, `closed`, `ping`
- Ereignisse: `h` Schlag, `w` Bande, `s` Anstoß, `g` Tor, `x` ausgeschieden, `v` Sieg, `r` Puck hing fest und kommt neu in die Mitte (`PHYSICS.stuckTime`/`stuckRadius`), `o` Verlängerung (Zeitmodus)
- Verliert ein Mitspieler im Spiel die Verbindung, übernimmt die KI seinen Schläger

## Handy
- Auf Touch-Geräten liegt im Spiel unten ein Touch-Feld (`#pad`, Zeichnen und Eingabe in `main.js`): zeigt die eigene Zone als Karte (oben = vorne, unten = eigenes Tor), damit der Finger nicht den Puck verdeckt. Zum Testen am Rechner: `?pad` an die Adresse hängen
- Direkt aufs Feld tippen geht weiterhin (Schläger sitzt `TOUCH_OFFSET` über dem Finger); auf dem Mitspieler-Handy wird der eigene Schläger sofort lokal angezeigt
- Als Web-App installierbar (`manifest.webmanifest`); später ggf. mit Capacitor als App verpacken
- Zum Spielen mit echten Handys muss die Seite über HTTPS erreichbar sein (z. B. GitHub Pages) – der QR-Code zeigt auf die aktuelle Adresse

- UI-Texte auf Deutsch, Bezeichner im Code auf Englisch

## GitHub & Veröffentlichen
- Projekt: github.com/CallMeJan57/hexhockey (öffentlich). Seite: https://callmejan57.github.io/hexhockey/ (GitHub Pages, liegt in einem Unterordner – deshalb nur relative Pfade verwenden)
- Zweige: `main` = Zwischenspeicher, `live` = veröffentlicht (GitHub Pages baut nur `live`)
- Änderungen committen und nach `main` pushen
- Veröffentlichen (`main` nach `live` mergen, `live` pushen) nur, wenn der Nutzer darum bittet
- `gh` ist nicht im PATH: `~/Downloads/gh_2.103.3_macOS_amd64/bin/gh`
