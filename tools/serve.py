#!/usr/bin/env python3
"""Serve app/public for local play-testing, with caching disabled so edits show up on reload.

    python3 tools/serve.py [port]

This is a static server: the game runs fully client-side and falls back to
local saves when the room endpoint (/ws) is not there.
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "public")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler) as srv:
        print(f"Serving {os.path.normpath(ROOT)} at http://localhost:{port}")
        srv.serve_forever()
