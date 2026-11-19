# Automatic guest input — Phase 4 UX polish

This changes only the React guest viewer and input engine. The existing authenticated Go relay, Windows Bridge and HIDMaestro Host Agent are unchanged.

- **Keyboard is the initial input source** when a guest is approved. There is no device picker or settings panel.
- Gamepads with the browser's `standard` mapping are sampled at ~60 Hz. A fresh button/trigger actuation or a stick beyond 0.4 switches the active input source to that gamepad; connecting the device alone does not select it.
- A new mapped keyboard key press switches back to keyboard. Switching sends a neutral state first, preventing a previous source from remaining held. Keyboard repeats do not trigger unnecessary switches.
- Stick dead zone remains 0.14 for gameplay; source-switch threshold is higher to avoid minor controller drift. Device disconnect returns to keyboard.
- The guest's VDO.Ninja stream is pointer-inert and removed from tab order, so ordinary clicks don't focus the video iframe. Entering the viewer focuses the YukMain player surface, and clicking the stream restores that focus. The fullscreen control restores focus after fullscreen transitions.
- Keyboard focus cannot be forced across operating-system windows or other browser tabs. Blur/tab-hide releases held inputs, and the player may need to click the YukMain window after switching back.
- A compact badge still identifies P2/P3/P4 and whichever input was last used. The existing connection retry remains visible only when disconnected.

## Manual validation
1. Open the guest link with no physical gamepad, join the room, press/hold W and J. Both should be mapped to Xbox inputs without a focus button.
2. Click anywhere on the video, then use W/J again. The keyboard should still work; video should not show its own interactive controls.
3. Connect a standard Xbox gamepad without pressing a control: the badge should remain Keyboard.
4. Press the gamepad A button or move a stick decisively: the badge should change to Gamepad. Verify both sticks and triggers.
5. Press W on keyboard: the badge should switch to Keyboard, with no stuck gamepad input.
6. Hold an arrow key and verify browser scrolling does not occur from key-repeat.
7. Disconnect the gamepad, switch apps/tabs, enter and exit fullscreen. Ensure neutral resets on focus loss and no stuck controller inputs.
8. Confirm P2/P3/P4 work independently with a real game.

### Limitation
Direct playback interactions inside the VDO.Ninja iframe, including any player-specific mute or volume controls, are now intentionally blocked. Audio control must be handled by YukMain itself or browser/system volume. Keyboard, gamepad, and guest UI remain usable.
