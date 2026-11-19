#!/usr/bin/env python3
"""Minimal in-memory signaling relay for the private room app."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import json, threading, time, os

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")

rooms = {}
lock = threading.Lock()
MAX_EVENTS = 500

class Handler(BaseHTTPRequestHandler):
    server_version = "Quietline/1.0"
    def log_message(self, *_): pass

    def send_headers(self, status=200, kind="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()

    def respond(self, data, status=200):
        raw = json.dumps(data, separators=(",", ":")).encode()
        self.send_headers(status); self.wfile.write(raw)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            try: data = open(os.path.join(BASE_DIR, "index.html"), "rb").read()
            except OSError: self.send_error(404); return
            self.send_headers(200, "text/html; charset=utf-8"); self.wfile.write(data); return
        if u.path == "/app.js":
            try: data = open(os.path.join(BASE_DIR, "app.js"), "rb").read()
            except OSError: self.send_error(404); return
            self.send_headers(200, "text/javascript; charset=utf-8"); self.wfile.write(data); return
        if u.path == "/styles.css":
            try: data = open(os.path.join(BASE_DIR, "styles.css"), "rb").read()
            except OSError: self.send_error(404); return
            self.send_headers(200, "text/css; charset=utf-8"); self.wfile.write(data); return
        if u.path == "/api/poll":
            q = parse_qs(u.query); room = q.get("room", [""])[0]; cursor = int(q.get("since", ["0"])[0])
            if not room or len(room) > 80: self.respond({"events": [], "cursor": cursor}, 400); return
            with lock:
                state = rooms.setdefault(room, {"events": [], "next": 1, "members": {}})
                result = [e for e in state["events"] if e["id"] > cursor]
                latest = state["next"] - 1
                members = list(state["members"].values())
            self.respond({"events": result, "cursor": latest, "members": members}); return
        self.send_error(404)

    def do_POST(self):
        if self.path != "/api/relay": self.send_error(404); return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n < 2 or n > 160000: self.respond({"error": "invalid payload size"}, 413); return
            body = json.loads(self.rfile.read(n))
            room, sender, kind, payload = body["room"], body["sender"], body["kind"], body["payload"]
            if not isinstance(room, str) or not 1 <= len(room) <= 80 or not isinstance(sender, str) or len(sender) > 80: raise ValueError()
            if not isinstance(payload, dict): raise ValueError()
            if kind not in ("ciphertext", "offer", "answer", "candidate", "hangup", "presence", "leave"): raise ValueError()
        except Exception:
            self.respond({"error": "invalid request"}, 400); return
        with lock:
            state = rooms.setdefault(room, {"events": [], "next": 1, "members": {}})
            cutoff = int(time.time()) - 3600
            state["events"] = [e for e in state["events"] if e["time"] >= cutoff]
            if kind == "presence":
                now = int(time.time())
                name = payload.get("name", "Guest")
                if not isinstance(name, str): name = "Guest"
                name = " ".join(name.split())[:32] or "Guest"
                state["members"][sender] = {"id": sender, "name": name, "seen": now}
                state["members"] = {k:v for k,v in state["members"].items() if now-v["seen"] < 25}
                self.respond({"ok": True})
                return
            if kind == "leave":
                state["members"].pop(sender, None)
                self.respond({"ok": True})
                return
            event = {"id": state["next"], "sender": sender, "kind": kind, "payload": payload, "time": int(time.time())}
            state["next"] += 1; state["events"].append(event); state["events"] = state["events"][-MAX_EVENTS:]
        self.respond({"ok": True, "id": event["id"]})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Quietline listening on http://localhost:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
