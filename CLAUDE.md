# Hex Hockey

3D-Airhockey in Draufsicht für 2–6 Spieler, jeder auf seinem eigenen Handy (auch iPhone). Jeder Spieler hat ein eigenes Tor an einer Seite eines Vielecks (2 Spieler: Quadrat, 3: Sechseck mit Banden dazwischen, 4–6: Vieleck mit so vielen Seiten wie Spieler). Jedes Gegentor kostet ein Leben; wer keine mehr hat, scheidet aus und sein Tor wird zugemauert. Der Letzte gewinnt.

Reines HTML/CSS/JS mit nativen ES-Modulen, kein Build-Schritt (Node ist nicht installiert). Three.js, PeerJS und qrcode-generator kommen per CDN (`index.html`).
Lokal starten: `python3 tools/serve.py` (Port 8010, ohne Browser-Cache; Konfiguration in `.claude/launch.json`).

## Aufbau
- `js/config.js` – alle Konstanten: Farben, Tischmaße, Physik, KI-Stufen, Netzwerk
- `js/arena.js` – Geometrie des Vielecks; Seite 0 liegt unten, `owner` = Spielerindex oder -1 (Bande)
- `js/physics.js` – Simulation (feste Schrittweite 1/240 s), läuft nur auf dem Host; `snapshot()` für die Mitspieler
- `js/ai.js` – KI-Gegner (verteidigen, hinter den Puck kommen, durchschlagen)
- `js/render.js` – Three.js-Szene; zeichnet einen „View“ (Simulation oder deren Abbild), Kamera dreht sich so, dass das eigene Tor unten ist
- `js/net.js` – Räume über WebRTC/PeerJS: Peer-ID = `hexhockey-v1-<CODE>`; der öffentliche PeerJS-Server vermittelt nur, die Daten gehen direkt zwischen den Handys
- `js/main.js` – Bildschirme (Start, Lobby, Spiel, Ende), Finger-Eingabe, Hauptschleife
- `js/audio.js` – synthetische Geräusche (WebAudio), erst nach der ersten Berührung aktiv (iPhone)

## Netzwerk-Protokoll
- Mitspieler → Host: `hello {name}`, `in {x, y}` (Fingerziel in Feldkoordinaten), `ping`
- Host → Mitspieler: `lobby`, `start {players, settings, you}`, `s` (Schnappschuss 30×/s inkl. Ereignisliste `ev`), `busy`, `full`, `closed`, `ping`
- Ereignisse: `h` Schlag, `w` Bande, `s` Anstoß, `g` Tor, `x` ausgeschieden, `v` Sieg
- Verliert ein Mitspieler im Spiel die Verbindung, übernimmt die KI seinen Schläger

## Handy
- Finger steuert den Schläger direkt (Schläger sitzt `TOUCH_OFFSET` über dem Finger, damit man ihn sieht); auf dem Mitspieler-Handy wird der eigene Schläger sofort lokal angezeigt
- Als Web-App installierbar (`manifest.webmanifest`); später ggf. mit Capacitor als App verpacken
- Zum Spielen mit echten Handys muss die Seite über HTTPS erreichbar sein (z. B. GitHub Pages) – der QR-Code zeigt auf die aktuelle Adresse

- UI-Texte auf Deutsch, Bezeichner im Code auf Englisch
