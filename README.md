# Quietline

A runnable, browser-based private messaging app with a small Python relay and direct peer-to-peer video calls.

## Run it

Requires Python 3.9 or newer. No package installation is needed.

```sh
cd /path/to/outputs
python3 ../server.py
```

Then open [http://localhost:8000](http://localhost:8000) in two browser windows or on two devices that can reach the host. Set `PORT` to use another port. Both people enter the same room name and encryption phrase. You can generate random room details in the app. Share the invite link and phrase through separate trusted channels. Display names are stored only in each browser; room members and messages update while the room is open. Video calls are currently one-to-one.

The repository root includes a `Dockerfile` and Docker Compose setup with Caddy for HTTPS. Copy `.env.example` to `.env`, set `APP_DOMAIN` to a domain whose DNS points to your server, then run `docker compose up -d --build` from the repository root. Allow inbound ports 80 and 443 in the server firewall. Caddy obtains and renews the TLS certificate automatically. For a plain local container, use `docker build -t quietline .` and `docker run --rm -p 8000:8000 quietline`.

For managed hosting, the repository root also contains `render.yaml`. Push the repository to a Git provider, connect that provider to Render, and create a Blueprint from the repository. Render deploys it as a Python web service. The free service may spin down after inactivity, and relay queues are in memory, so messages are temporary.

For use across the internet, put the app behind HTTPS. Browsers only allow camera and microphone access on secure origins (localhost is permitted). A restrictive network may also require a TURN relay for calls; configure a TURN service in `app.js` if needed. The included STUN server helps peers discover a direct route but does not relay media.

## What is encrypted

- Chat text is encrypted in the browser with AES-256-GCM. The encryption key is derived from the room phrase using PBKDF2-HMAC-SHA-256 (310,000 iterations) and a room-specific salt. A fresh random nonce is used for every message.
- The relay only receives ciphertext for chat. It holds queued events in memory for up to one hour (and at most 500 recent events per room); it does not write message data to disk. Restarting the process clears the queues.
- Calls use a direct WebRTC peer connection. WebRTC encrypts audio and video with DTLS-SRTP between the two browsers. If a TURN service is used, it forwards encrypted media packets. There is no SFU in this app.

## Security boundaries

The phrase is a shared secret, so anyone who learns it can read room messages. The phrase is not sent to the relay, but anyone who can access a participant's device or browser session can read that participant's messages. This app does not yet provide verified identities, device management, message history, attachments, push notifications, abuse controls, or multi-device key rotation. Room names and connection metadata are visible to the relay. Use a unique, high-entropy phrase and compare it with your contact in person or through another trusted channel.

This is a small self-hostable app, not an audited cryptographic product. The Python relay is an in-memory demonstrator intended for small private rooms; for public deployment, add authentication, rate limiting, monitoring, robust TURN configuration, and a security review.
