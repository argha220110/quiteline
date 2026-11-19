"""Quietline web app and bounded in-memory signaling relay."""
from __future__ import annotations

import os
import ipaddress
import threading
import time
from collections import deque
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
OUTPUTS = BASE_DIR / "outputs"
MAX_EVENTS = 500
MAX_ROOMS = 1000
MAX_MEMBERS = 32
ROOM_TTL = 3600
MEMBER_TTL = 25
RATE_WINDOW_SECONDS = 60
RATE_LIMIT_PER_IP = 3000
MAX_RATE_LIMIT_CLIENTS = 10000
ALLOWED_KINDS = {"ciphertext", "offer", "answer", "candidate", "hangup", "presence", "leave"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
rooms: dict[str, dict] = {}
request_times: dict[str, deque] = {}
lock = threading.Lock()


@app.after_request
def security_headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self' data:; media-src 'self' blob:; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'"
    )
    return response


@app.errorhandler(413)
def oversized_request(_error):
    return jsonify(error="invalid payload size"), 413


def prune(now: int) -> None:
    expired = [key for key, value in rooms.items() if now - value["updated"] > ROOM_TTL]
    for key in expired:
        del rooms[key]


def room_for(key: str, now: int) -> dict:
    state = rooms.get(key)
    if state is None:
        prune(now)
        if len(rooms) >= MAX_ROOMS:
            raise OverflowError
        state = {"events": [], "next": 1, "members": {}, "updated": now}
        rooms[key] = state
    state["updated"] = now
    return state


def client_ip() -> str:
    """Use the address appended by the trusted hosting/reverse proxy."""
    forwarded = request.headers.get("X-Forwarded-For", "")
    candidate = forwarded.split(",")[-1].strip() if forwarded else (request.remote_addr or "unknown")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return request.remote_addr or "unknown"


@app.before_request
def limit_api_requests():
    if request.path not in {"/api/poll", "/api/relay"}:
        return None
    now = time.monotonic()
    cutoff = now - RATE_WINDOW_SECONDS
    key = client_ip()
    with lock:
        bucket = request_times.get(key)
        if bucket is None:
            if len(request_times) >= MAX_RATE_LIMIT_CLIENTS:
                for old_key, old_bucket in list(request_times.items()):
                    if not old_bucket or old_bucket[-1] <= cutoff:
                        del request_times[old_key]
                if len(request_times) >= MAX_RATE_LIMIT_CLIENTS:
                    return jsonify(error="server is busy; try again shortly"), 503
            bucket = request_times[key] = deque()
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_PER_IP:
            response = jsonify(error="too many requests; please wait a minute and try again")
            response.status_code = 429
            response.headers["Retry-After"] = str(max(1, int(bucket[0] + RATE_WINDOW_SECONDS - now)))
            return response
        bucket.append(now)
    return None


@app.get("/")
def index():
    return send_from_directory(OUTPUTS, "index.html")


@app.get("/app.js")
def javascript():
    return send_from_directory(OUTPUTS, "app.js")


@app.get("/styles.css")
def stylesheet():
    return send_from_directory(OUTPUTS, "styles.css")


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/api/poll")
def poll():
    room = request.args.get("room", "")
    try:
        cursor = int(request.args.get("since", "0"))
    except ValueError:
        return jsonify(error="invalid cursor"), 400
    if not 1 <= len(room) <= 80 or cursor < 0:
        return jsonify(error="invalid request"), 400
    now = int(time.time())
    try:
        with lock:
            state = room_for(room, now)
            cutoff = now - ROOM_TTL
            state["events"] = [event for event in state["events"] if event["time"] >= cutoff]
            state["members"] = {key: value for key, value in state["members"].items()
                                 if now - value["seen"] < MEMBER_TTL}
            result = [event for event in state["events"] if event["id"] > cursor]
            latest = state["next"] - 1
            members = list(state["members"].values())
    except OverflowError:
        return jsonify(error="server is at room capacity; try again later"), 503
    return jsonify(events=result, cursor=latest, members=members)


@app.post("/api/relay")
def relay():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="invalid request"), 400
    room, sender, kind, payload = (body.get(field) for field in ("room", "sender", "kind", "payload"))
    if (not isinstance(room, str) or not 1 <= len(room) <= 80
            or not isinstance(sender, str) or not 1 <= len(sender) <= 80
            or kind not in ALLOWED_KINDS or not isinstance(payload, dict)):
        return jsonify(error="invalid request"), 400

    now = int(time.time())
    try:
        with lock:
            state = room_for(room, now)
            state["events"] = [event for event in state["events"] if now - event["time"] <= ROOM_TTL]
            state["members"] = {key: value for key, value in state["members"].items()
                                 if now - value["seen"] < MEMBER_TTL}
            if kind == "presence":
                if sender not in state["members"] and len(state["members"]) >= MAX_MEMBERS:
                    return jsonify(error="room is at member capacity"), 429
                name = payload.get("name", "Guest")
                if not isinstance(name, str):
                    name = "Guest"
                name = " ".join(name.split())[:32] or "Guest"
                state["members"][sender] = {"id": sender, "name": name, "seen": now}
                return jsonify(ok=True)
            if kind == "leave":
                state["members"].pop(sender, None)
                return jsonify(ok=True)
            event = {"id": state["next"], "sender": sender, "kind": kind,
                     "payload": payload, "time": now}
            state["next"] += 1
            state["events"].append(event)
            state["events"] = state["events"][-MAX_EVENTS:]
    except OverflowError:
        return jsonify(error="server is at room capacity; try again later"), 503
    return jsonify(ok=True, id=event["id"])


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
