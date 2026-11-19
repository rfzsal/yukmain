# Instant game room — implementation and manual acceptance

## Guest UX
- Join via room link with no login and no guest debug panel.
- If the host enabled **Instant controller join** and the Windows Agent is online, the server atomically leases the first available P2/P3/P4 slot; no manual request or approval is necessary.
- The guest sees a minimal connected player badge above the VDO.Ninja stream, with a settings icon for choosing keyboard or standard-mapped physical gamepad. Physical gamepads are auto-selected on detection.
- Fullscreen leaves video and a small player badge visible; the normal navigation HUD fades after 2.2 seconds of pointer inactivity.
- Inactivity/blur/tab hidden sends neutral state; Windows Agent still enforces its independent 1.2-second watchdog.
- When the WebSocket closes, an instant-join slot is reclaimed. Pending HTTP claims without a WebSocket connection expire after 15 seconds.

## Host UX and security
- Host chooses whether **Instant controller join** is enabled per room (OFF by default). Only the host bearer token can change this setting.
- The real Windows Host Agent must be paired and connected before any instant-join allocation is accepted.
- Each room grants only P2–P4. One slot per guest. Slot assignments occur atomically inside the server mutex.
- The host can revoke a guest's slot. A current connected guest never loses a slot to a new guest.
- Disabling instant join blocks new automatic assignments; already connected guests remain until revoked or disconnected.

## Acceptance
1. Host pairs the Windows Agent, enables instant controller join.
2. Guest opens link and sees P2 connected without manual approval. Hold controller A/W for ten seconds.
3. Join two more browsers; expect P3 and P4. The fourth sees all slots occupied.
4. Disconnect the P2 browser; a new guest should receive P2 while P3/P4 retain their slots.
5. Disable instant controller join; the next guest should be denied automatic control (host may still use manual approval).
6. Disconnect Windows Agent; new instant joins must fail, and existing input should reset.
7. Verify fullscreen HUD fades, P2/P3/P4 badge remains, and the settings icon can reveal keyboard/gamepad selection.

## Known limits
- Browser fullscreen is subject to the browser's user-gesture requirement.
- Physical gamepads require a standard Gamepad API mapping. Touch controls are not yet provided.
- Automatic retry is user-triggered; there is no seamless token-preserving reconnection yet.
- This PR requires a Go build/test, TypeScript/Vite build and real Windows gameplay verification.
