#!/usr/bin/env python3
"""
Lokaler Entwicklungsserver für Hex Hockey – wie `python3 -m http.server`, aber ohne Browser-Cache.

Der eingebaute Server schickt keine Cache-Anweisungen; der Browser hält dann geänderte JS-Module
(z. B. neue Begriffe in terms.js) fest und zeigt alte Stände. Hier bekommt jede Antwort `no-store`.

Aufruf im Projektordner:  python3 tools/serve.py [port]   (Standard: 8000)
"""

import errno
import http.server
import sys
import time
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.webmanifest': 'application/manifest+json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(NoCacheHandler, directory=str(ROOT))
    # Läuft schon ein Server auf dem Port (z. B. ein zweiter Start derselben Konfiguration), wird nicht
    # abgebrochen: die Seite ist ja erreichbar. Dieser Prozess wartet und übernimmt, sobald der Port frei wird.
    waiting = False
    while True:
        try:
            server = http.server.ThreadingHTTPServer(('', port), handler)
            break
        except OSError as err:
            if err.errno != errno.EADDRINUSE:
                raise
            if not waiting:
                print(f'Port {port} ist schon belegt – http://localhost:{port} läuft bereits; warte, bis er frei wird.', flush=True)
                waiting = True
            time.sleep(2)
    with server:
        print(f'Hex Hockey läuft auf http://localhost:{port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
