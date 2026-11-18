# Phase 2 — server WebSocket relay test

This phase tests authenticated controller-state transport through the **deployed YukMain server** using a host browser and viewer browser. It does not yet control Steam.

## Enable on a controlled deployment

Set `YUKMAIN_RELAY_DEBUG=1` for the **api** service (for example via the Compose .env interpolation) and redeploy the **web + api** services. Do not expose the debug feature on an untrusted production instance; it is only a temporary test surface.

The same HTTPS origin is used for WebSocket (`wss://<host>/api/rooms/<code>/relay`). Nginx now preserves the WebSocket Upgrade/Connection headers and has a longer read timeout.

No new inbound ports are required; Go remains internal to Docker.

## Live browser test

1. Open the deployed YukMain website as host, create a room, and keep its studio open for heartbeat.
2. The host studio shows **WebSocket Relay Debug**. Wait for *Authenticated as host*.
3. Open the invite link in a separate browser/private window as a viewer.
4. Viewer clicks **Request controller** in its debug panel. Its status becomes pending.
5. In host debug panel, approve that guest for **P2**.
6. Viewer clicks **Press A**, then **Release all**.
7. Host debug log must show P2 A and then P2 neutral, with increasing sequence numbers.
8. Reject/revoke the player. New input must be blocked and a neutral reset delivered.
9. Disconnect the viewer. Host should see a neutral reset event.
10. Check HTTPS, console, and reverse-proxy errors. Repeat on another network.

## HTTP and WebSocket contract

- `POST /api/rooms/:code/players`: obtain an ephemeral guest ID/token, pending by default. Requires a valid room code; rate-limited and capped to 12 requests per room.
- `GET /api/rooms/:code/players`: host-only list of pending/approved guests.
- `PATCH /api/rooms/:code/players/:id`: host-only approval, rejection, and assignment to unique slot P2/P3/P4.
- `GET /api/rooms/:code/relay?role=host|player&playerId=<id>`: WebSocket upgrade. Host uses the room's host bearer token; player uses the issued player token.
- WebSocket client subprotocols: `['yukmain.v1', 'yukmain-host.<hostToken>']` or `['yukmain.v1', 'yukmain-player.<playerToken>']`. The server negotiates `yukmain.v1`. Tokens are never passed as URL query parameters.
- `controller.state`: complete snapshot with `seq`, `buttons`, `dpad`, `leftStick`, `rightStick`, `leftTrigger`, `rightTrigger`.
- Server forwards validated snapshots with authoritative `slot` and `playerId`; rejected, stale, and rate-limited frames are not forwarded.
- `controller.neutral`: host event on revocation or player disconnection. The future Agent must apply this as immediate reset.
- `GET /api/relay/config`: exposes the debug UI flag, no private data.

**Security:** These routes are disabled unless the server is explicitly configured for debug. The room code alone does **not** grant controller permission. WebSocket host registration requires a private host token and each guest must be approved to transmit. This is an in-memory single-instance implementation, matching the existing Go room API.

## Automated tests

Run from `api/`:

```sh
go test ./...
go vet ./...
```

Run React production checks from `web/`:

```sh
npm ci
npm run build
```

## Limitations

- Keep one Go API instance: room state and live sockets are process-local. API restart disconnects every room.
- Approval and player connection control are limited to Phase 2 debug. Host Agent is not yet integrated; Phase 3 will need elevated-helper isolation.
- No guest accounts, persistent guest identities, native controller output, or gamepad mapping yet.
- The player creation endpoint permits a valid room code to request approval; do not treat the six-digit room code as a trusted identity.
- The browser debug panel intentionally sends only an A-button and neutral snapshot; full gamepad input comes in a later phase.
