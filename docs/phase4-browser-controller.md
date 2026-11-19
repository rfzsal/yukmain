# Phase 4 — Browser controller (keyboard and physical gamepad)

## Scope
- Supports the existing Phase 3 player registration, approval, WebSocket credentials and P2/P3/P4 slots.
- When a player is approved and connected, React sends complete `controller.state` snapshots at approximately 60 Hz while input is active. Neutral snapshots are sent around twice per second.
- Release and disconnect safeguards: keyboard keyup, page blur, tab hidden, mode switch and component teardown send neutral snapshots when a WebSocket is still available. Windows Agent keeps its independent 1.2-second stale-input watchdog.
- Standard Gamepad API mapping supports both sticks, D-pad, A/B/X/Y, bumpers, triggers, Start/Back and stick clicks.
- Physical controllers that don't expose `mapping === 'standard'` are excluded until a user-specific mapping UI is added.
- Mobile touch gamepad is a later milestone, not part of this PR.

## Keyboard controls
| Keyboard | Xbox virtual controller |
|---|---|
| W/A/S/D | Left stick |
| Arrow keys | D-pad |
| J/K/U/I | A/B/X/Y |
| Q/E | LB/RB |
| 1/2 | LT/RT |
| Enter/Backspace | Start/Back |
| Z/C | Left/right stick click |

The embedded VDO.Ninja iframe can receive browser focus. Click **Click to focus keyboard controls** in the controller panel after interacting with video to return keyboard focus to YukMain.

## Acceptance test
1. Deploy web build with the existing Phase 3 API and pair Windows Bridge/Agent.
2. From a second device, join the room and request a controller; host approves P2.
3. Choose Keyboard, click the focus button, hold W for ten seconds. Watch P2 left stick stay displaced in Gamepad Tester, then return to center on key release.
4. Hold J for ten seconds. Verify the A button remains pressed; release J and verify A resets.
5. Switch to Physical gamepad, connect an Xbox/standard-mapped controller and press a button to activate the browser Gamepad API. Choose the controller and verify sticks/buttons/triggers.
6. Close the player tab while holding an input; virtual gamepad must return neutral (the Windows watchdog provides a fallback).
7. Repeat independently for P2/P3/P4 and check for crossed inputs.

## Known limitations
- Browser keyboard control requires focus outside the embedded video iframe.
- iOS/browser support for specific physical controller hardware varies.
- No automatic reconnection of the player socket after network loss.
- No game-specific controller profiles, remapping UI, rumble or mobile touch controls yet.
- Build and Windows end-to-end verification are required before merging.
