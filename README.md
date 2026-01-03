# anpush -- prototype webpush for wiredove

anpush is a small Deno server that polls `https://pub.wiredove.net/latest` and sends Web Push notifications when new anproto messages appear. It also serves a simple web UI for subscribing/unsubscribing and testing a manual poll.

## What it does
- Polls the latest anproto message on an interval.
- Deduplicates notifications using the latest `hash` (or fallback fields).
- Sends Web Push notifications with VAPID keys.
- Serves a minimal browser UI and Service Worker for subscription management.

## Requirements
- Deno 1.40+ (any modern Deno with npm support)
- HTTPS for push in production (localhost is allowed for development)

## Run it
Generate VAPID keys (one-time) and write them to `config.json`:

```bash
deno run -A scripts/generate_vapid_keys.ts
```

Start the server:

```bash
deno run -A server.ts
```

Open the UI:

```
http://localhost:8080/
```

## Configuration
Environment variables are optional:
- `PORT` (default `8080`)
- `POLL_MS` (default `120000`)
- `LATEST_URL` (default `https://pub.wiredove.net/latest`)
- `VAPID_SUBJECT` (default `mailto:ops@wiredove.net`)

VAPID keys live in `config.json` at the project root:

```json
{
  "vapidPublicKey": "...",
  "vapidPrivateKey": "...",
  "vapidSubject": "mailto:ops@wiredove.net"
}
```

## Notes
- The notification URL is `https://wiredove.net/#<hash>`.
- Subscriptions and state are stored in `data/`.

---
MIT
