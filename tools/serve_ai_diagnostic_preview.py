#!/usr/bin/env python3
"""Serve the diagnostic branch to a trusted LAN for Android testing.

Run from the repository root on a trusted private Wi-Fi network:
  python3 tools/serve_ai_diagnostic_preview.py

This serves static files only. It does not connect to Firebase or Cloudflare.
Use a disposable browser profile and the ?anasDiagIsolated=1 query string.
Do not use public Wi-Fi, port forwarding, or production data.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]
PORT = 4173

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Expose only the app shell. Never expose repository files, .git, tests, or workflows.
        if self.path.split("?", 1)[0] not in ("/", "/index.html"):
            self.send_error(404, "Only the diagnostic app shell is served")
            return
        self.path = "/index.html"
        super().do_GET()

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

def lan_addresses():
    found = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip.startswith(("10.", "192.168.", "172.")):
                found.add(ip)
    except OSError:
        pass
    return sorted(found)

if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as exc:
        print(f"Cannot start preview server on port {PORT}: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print("ANAS ERP diagnostic preview server (static files only)")
    print("Stop with Ctrl+C. Keep this on trusted private Wi-Fi only.")
    print("On the Android phone, open one of these URLs:")
    addresses = lan_addresses()
    if not addresses:
        print(f"  Find this computer's private LAN IPv4 address, then open http://<LAN-IP>:{PORT}/index.html?anasDiagIsolated=1")
    else:
        for ip in addresses:
            print(f"  http://{ip}:{PORT}/index.html?anasDiagIsolated=1")
    print("Do not enter real business data. Do not expose this port to the internet.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping diagnostic preview server.")
    finally:
        server.server_close()
