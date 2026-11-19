# Quietline

A browser-based private messaging app with a Python signaling relay and direct peer-to-peer video calls.

## Run it

Requires Python 3.10 or newer. Install the pinned server dependencies from the repository root.

```sh
cd /path/to/quiteline
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Then open [http://localhost:8000](http://localhost:8000) in two browser windows or on two devices that can reach the host. Set `PORT` to use another port. Both people enter the same room name and encryption phrase. You can generate random room details in the app. Share the invite link and phrase through separate trusted channels. Display names are saved in the browser and visible to current room members; the relay sees them while you are online. Video calls are currently one-to-one.

The repository root includes a `Dockerfile` and Docker Compose setup with Caddy for HTTPS. Copy `.env.example` to `.env`, set `APP_DOMAIN` to a domain whose DNS points to your server, then run `docker compose up -d --build` from the repository root. Allow inbound ports 80 and 443 in the server firewall. Caddy obtains and renews the TLS certificate automatically. For a plain local container, use `docker build -t quietline .` and `docker run --rm -p 8000:8000 quietline`.

For managed hosting, the repository root also contains `render.yaml`. Connect the repository to Render or create a Blueprint from it. Production runs the Flask app under Gunicorn with one worker and multiple threads; one worker is required because relay queues are held in process memory. The health check is available at `/health`. The free service may spin down after inactivity, and relay queues are in memory, so messages are temporary.

For use across the internet, put the app behind HTTPS. Browsers only allow camera and microphone access on secure origins (localhost is permitted). A restrictive network may also require a TURN relay for calls; configure a TURN service in `app.js` if needed. The included STUN server helps peers discover a direct route but does not relay media.

## What is encrypted

- Chat text is encrypted in the browser with AES-256-GCM. The encryption key is derived from the room phrase using PBKDF2-HMAC-SHA-256 (310,000 iterations) and a room-specific salt. A fresh random nonce is used for every message.
- The relay only receives ciphertext for chat. It holds queued events in memory for up to one hour (and at most 500 recent events per room); it does not write message data to disk. Restarting the process clears the queues.
- Calls use a direct WebRTC peer connection. WebRTC encrypts audio and video with DTLS-SRTP between the two browsers. If a TURN service is used, it forwards encrypted media packets. There is no SFU in this app.

## Security boundaries

The phrase is a shared secret, so anyone who learns it can read room messages. The phrase is not sent to the relay, but anyone who can access a participant's device or browser session can read that participant's messages. This app does not yet provide verified identities, device management, message history, attachments, push notifications, abuse controls, or multi-device key rotation. Room names, display names and connection metadata are visible to the relay. Use a unique, high-entropy phrase and compare it with your contact in person or through another trusted channel.

This is an early-stage self-hostable app, not an audited cryptographic product. The relay limits payload size, room count, members per room, and API requests per client IP (3,000 per minute). It does not provide account authentication, verified identities, abuse reporting, operational monitoring, or independently reviewed cryptography. Use it for small private conversations only; sensitive communications need a professional security review and operational monitoring. The IP limit assumes the app is behind Render's proxy or a trusted reverse proxy that appends the visitor address to `X-Forwarded-For`.
