"""
Dance-Dance — local network hub server
Python 3.7+, stdlib only (no pip required)

Adapted from flutterby/server.py (same design: stdlib-only threaded HTTP
server with an SSE broadcast channel), with the API renamed from
butterflies to dancers.

Usage:
  python scripts/server.py          # default port 9000
  python scripts/server.py 8080     # custom port

API:
  GET    /api/dancers     — return all dancers as JSON array
  POST   /api/submit      — add a new dancer; broadcast to all dance-floor screens via SSE
  DELETE /api/dancers/<id> — remove a dancer by ID; broadcast removal via SSE
  GET    /api/events      — SSE stream for dance-floor screens (new-dancer, remove-dancer events)
  GET    /api/host-info   — {ip, port}: LAN address for the join-code QR on the dance floor

All other paths are served as static files from the piece root (this file's
parent folder's parent): dance-dance.html, upload.html, scripts/*.js, images/...
Dancers are persisted to dancers-data.json.
"""

import json
import mimetypes
import os
import queue
import socket
import sys
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Ensure .js and .css files are served with the correct Content-Type so
# mobile browsers (which enforce strict MIME checking) will execute them
# rather than refusing with "Refused to execute script from '…' because
# its MIME type ('application/octet-stream') is not executable."
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')

# Windows consoles default to a legacy codepage (e.g. cp1252) that can't
# encode the arrows/dashes in the startup banner below — force UTF-8 so
# `python scripts/server.py` doesn't crash before it even starts listening.
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# This file lives in scripts/; the served piece root is its parent folder.
ROOT = Path(__file__).resolve().parent.parent

# ── Persistence ───────────────────────────────────────────────────────────────
DATA_FILE = ROOT / 'dancers-data.json'

dancers_lock = threading.Lock()
dancers: list = []

def load_dancers():
    global dancers
    if DATA_FILE.exists():
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                dancers = data
                print(f'  Loaded {len(dancers)} dancer(s) from {DATA_FILE.name}')
        except Exception as e:
            print(f'  Warning: could not load {DATA_FILE.name}: {e}')

def save_dancers():
    """Write dancers list to disk. Must be called with dancers_lock held."""
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(dancers, f)

# ── SSE client registry ───────────────────────────────────────────────────────
clients_lock = threading.Lock()
clients: list = []  # list of queue.Queue, one per connected dance-floor screen

def broadcast(event: str, data: str):
    """Push an SSE event to every connected dance-floor screen."""
    message = f'event: {event}\ndata: {data}\n\n'.encode('utf-8')
    with clients_lock:
        dead = []
        for q in clients:
            try:
                q.put_nowait(message)
            except queue.Full:
                dead.append(q)
        for q in dead:
            clients.remove(q)

# ── Request handler ───────────────────────────────────────────────────────────
class DancerHandler(SimpleHTTPRequestHandler):

    # Silence the default access log — comment out to re-enable
    def log_message(self, format, *args):
        pass

    def _send_json(self, status: int, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return None
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self):
        if self.path == '/api/dancers':
            with dancers_lock:
                data = list(dancers)
            self._send_json(200, data)

        elif self.path == '/api/events':
            self._handle_sse()

        elif self.path == '/api/host-info':
            self._send_json(200, {
                'ip': get_local_ip(),
                'port': self.server.server_address[1],
            })

        else:
            # Serve static files (HTML, JS, images, etc.)
            super().do_GET()

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        if self.path == '/api/submit':
            try:
                dancer = self._read_json_body()
                if not isinstance(dancer, dict) or 'textureDataURL' not in dancer or 'mesh' not in dancer:
                    self._send_json(400, {'error': 'Invalid dancer data'})
                    return
                with dancers_lock:
                    dancers.append(dancer)
                    save_dancers()
                broadcast('new-dancer', json.dumps(dancer))
                self._send_json(200, {'ok': True})
                name = dancer.get('name') or 'Unnamed dancer'
                print(f'  [+] Dancer received: "{name}" (total: {len(dancers)})')
            except Exception as e:
                self._send_json(500, {'error': str(e)})

        else:
            self._send_json(404, {'error': 'Not found'})

    # ── OPTIONS (CORS preflight) ──────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # ── DELETE ────────────────────────────────────────────────────────────────

    def do_DELETE(self):
        prefix = '/api/dancers/'
        if self.path.startswith(prefix):
            dancer_id = self.path[len(prefix):]
            if not dancer_id:
                self._send_json(400, {'error': 'Missing dancer ID'})
                return
            removed = None
            with dancers_lock:
                for i, d in enumerate(dancers):
                    if d.get('id') == dancer_id:
                        removed = dancers.pop(i)
                        save_dancers()
                        break
            if removed is None:
                self._send_json(404, {'error': 'Dancer not found'})
                return
            broadcast('remove-dancer', json.dumps({'id': dancer_id}))
            name = removed.get('name') or 'Unnamed dancer'
            print(f'  [-] Dancer removed: "{name}" (total: {len(dancers)})')
            self._send_json(200, {'ok': True, 'id': dancer_id})
        else:
            self._send_json(404, {'error': 'Not found'})

    # ── SSE stream ────────────────────────────────────────────────────────────

    def _handle_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        q = queue.Queue(maxsize=50)
        with clients_lock:
            clients.append(q)

        ping = b': ping\n\n'  # keep-alive comment line (not an event)

        try:
            while True:
                try:
                    msg = q.get(timeout=30)
                    self.wfile.write(msg)
                    self.wfile.flush()
                except queue.Empty:
                    # Send a keep-alive ping so the connection doesn't time out
                    self.wfile.write(ping)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with clients_lock:
                if q in clients:
                    clients.remove(q)

# ── Server (suppresses benign client-disconnect noise) ────────────────────────

_BENIGN_ERRORS = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)

class DancerServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if issubclass(sys.exc_info()[0], _BENIGN_ERRORS):
            return  # browser closed the connection — not a real error
        super().handle_error(request, client_address)

# ── Local IP helper ───────────────────────────────────────────────────────────

def get_local_ip() -> str:
    try:
        # Connect to a public address without actually sending anything;
        # lets us find the outbound interface IP on the local network.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000

    # Serve files from the piece root (parent of scripts/)
    os.chdir(ROOT)

    load_dancers()

    ip = get_local_ip()
    now = datetime.now().strftime('%H:%M')

    print()
    print('  Dance-Dance — Hub Server')
    print(f'  Started at {now}')
    print(f'  Dance floor screen  →  http://localhost:{port}/dance-dance.html')
    print(f'  Phone upload        →  http://{ip}:{port}/upload.html')
    print('  Press Ctrl+C to stop the server')
    print()

    server = DancerServer(('', port), DancerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        print('\n  Server stopped.')

if __name__ == '__main__':
    main()
