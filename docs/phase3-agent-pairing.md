# Phase 3 — Windows Agent pairing and remote input

## Architecture

The Go API issues a one-time 8-character pairing code valid for 3 minutes.
The host browser owns the room and generates the code. A separate, ordinary-
user `YukMain.Host.Bridge` console program redeems the code over HTTPS and
connects via WSS as `role=agent`. The Bridge sends only controller messages
into a **current-user-only named pipe** exposed by the existing elevated
YukMain Host Agent (WPF). The elevated application **never opens a network
socket**. The WPF app still performs HIDMaestro initialization and owns P2-P4.

## Go endpoints

- `POST /api/rooms/:code/pairing` (room owner's Bearer host token):
  generate a new code; invalidates the previous agent session.
- `POST /api/rooms/:code/pairing/redeem` (body `{"pairingCode":"..."}`):
  validate one-time code and return a room-scoped agent token.
- `GET /api/rooms/:code/pairing` (host bearer token):
  return `paired` and `agentConnected`.
- `GET /api/rooms/:code/relay?role=agent`:
  WebSocket with subprotocols `yukmain.v1` and `yukmain-agent.<token>`.
- Browser player authorization and room relay remain compatible with Phase 2.

## Test on deployed server

1. Merge/deploy the Go+React branch.
2. Run the elevated Host Agent on Windows, initialize the driver, and create P2.
3. From the regular (non-admin) Windows terminal, launch the built
   `YukMain.Host.Bridge.exe`; enter the HTTPS site URL, room code, and
   the one-time pairing code from the host studio.
4. Wait for Bridge to report WSS connected and attached to named pipe;
   host studio should show **Agent connected**.
5. From a second browser, join the room and request P2 control. Host approves.
6. Send A and Release all; use Windows Gamepad Tester or `joy.cpl` to
   verify the virtual controller changes.
7. Disconnect the viewer and confirm the virtual controller neutralizes.
8. Stop the Bridge and confirm every virtual controller resets.

Pairing codes and agent credentials must not appear in logs or be copied into
URLs. Do not run the bridge as administrator. The host studio is authenticated
by its existing host token. Only one host receiver can be active per room.

## Limitations

The controller SDK remains in the existing elevated WPF UI, but all remote
WebSocket/HTTP processing occurs in the ordinary-user Bridge. This design is
a development milestone, not a security-reviewed production boundary.
The named pipe is user-restricted but not a permission-granular sandbox.
Driver installation still requires administrator consent.
A future release should add stronger broker authorization, installer signing,
and richer connection/reconnect UX. Gamepad ordering is game-dependent.
