import { useEffect, useRef } from 'react';

export type InputDevice = 'keyboard' | 'gamepad';
export type ControllerSnapshot = {
  buttons: string[];
  dpad: string;
  leftStick: { x: number; y: number };
  rightStick: { x: number; y: number };
  leftTrigger: number;
  rightTrigger: number;
};

export function neutralState(): ControllerSnapshot {
  return {
    buttons: [], dpad: 'none',
    leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 },
    leftTrigger: 0, rightTrigger: 0,
  };
}

const keyboardButtons: Record<string, string> = {
  KeyJ: 'A', KeyK: 'B', KeyU: 'X', KeyI: 'Y',
  KeyQ: 'LB', KeyE: 'RB', Enter: 'Start',
  Backspace: 'Back', KeyZ: 'LS', KeyC: 'RS',
};
const controlKeys = new Set([
  ...Object.keys(keyboardButtons), 'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Digit1', 'Digit2',
]);
const clamp = (n: number) => Math.max(-1, Math.min(1, n));

function axis(n: number): number {
  if (!Number.isFinite(n) || Math.abs(n) < 0.14) return 0;
  return Math.round(clamp((n - Math.sign(n) * 0.14) / 0.86) * 1000) / 1000;
}

function active(state: ControllerSnapshot): boolean {
  return state.buttons.length > 0 || state.dpad !== 'none' ||
    state.leftStick.x !== 0 || state.leftStick.y !== 0 ||
    state.rightStick.x !== 0 || state.rightStick.y !== 0 ||
    state.leftTrigger > 0 || state.rightTrigger > 0;
}

function keyboardState(keys: ReadonlySet<string>): ControllerSnapshot {
  const state = neutralState();
  state.buttons = Object.entries(keyboardButtons)
    .filter(([key]) => keys.has(key)).map(([, button]) => button);
  const x = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
  const y = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
  const length = Math.hypot(x, y) || 1;
  state.leftStick = { x: x / length, y: y / length };
  const up = keys.has('ArrowUp'), down = keys.has('ArrowDown');
  const left = keys.has('ArrowLeft'), right = keys.has('ArrowRight');
  const vertical = up === down ? '' : up ? 'up' : 'down';
  const horizontal = left === right ? '' : left ? 'left' : 'right';
  state.dpad = [vertical, horizontal].filter(Boolean).join('-') || 'none';
  state.leftTrigger = keys.has('Digit1') ? 1 : 0;
  state.rightTrigger = keys.has('Digit2') ? 1 : 0;
  return state;
}

function gamepadState(pad: Gamepad): ControllerSnapshot {
  const state = neutralState();
  const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', '', '', 'Back', 'Start', 'LS', 'RS'];
  state.buttons = names.filter((name, index) => name && !!pad.buttons[index]?.pressed);
  const up = !!pad.buttons[12]?.pressed, down = !!pad.buttons[13]?.pressed;
  const left = !!pad.buttons[14]?.pressed, right = !!pad.buttons[15]?.pressed;
  const vertical = up === down ? '' : up ? 'up' : 'down';
  const horizontal = left === right ? '' : left ? 'left' : 'right';
  state.dpad = [vertical, horizontal].filter(Boolean).join('-') || 'none';
  state.leftStick = { x: axis(pad.axes[0] ?? 0), y: axis(pad.axes[1] ?? 0) };
  state.rightStick = { x: axis(pad.axes[2] ?? 0), y: axis(pad.axes[3] ?? 0) };
  state.leftTrigger = Math.max(0, Math.min(1, pad.buttons[6]?.value ?? 0));
  state.rightTrigger = Math.max(0, Math.min(1, pad.buttons[7]?.value ?? 0));
  return state;
}

// Observe input *changes*, never a constant, potentially non-zero idle axis.
// Some browser/driver combinations expose resting axes at -1 or +1.
type GamepadActivity = {
  previousButtons: number[];
  referenceAxes: number[];
};
function buttonValue(button: GamepadButton): number {
  return button.pressed ? 1 : Number.isFinite(button.value) ? button.value : 0;
}
function freshGamepadInput(pad: Gamepad, previous: GamepadActivity): boolean {
  const pressed = pad.buttons.some((button, index) =>
    buttonValue(button) >= 0.65 && (previous.previousButtons[index] ?? 0) < 0.35);
  const moved = pad.axes.some((axisValue, index) =>
    Number.isFinite(axisValue) &&
    Math.abs(axisValue) >= 0.45 &&
    Math.abs(axisValue - (previous.referenceAxes[index] ?? axisValue)) >= 0.4);
  return pressed || moved;
}
function rememberButtons(pad: Gamepad, previous: GamepadActivity) {
  previous.previousButtons = pad.buttons.map(buttonValue);
}
function observedPad(pad: Gamepad): GamepadActivity {
  return {
    previousButtons: pad.buttons.map(buttonValue),
    referenceAxes: [...pad.axes],
  };
}

export type InputMode = 'auto' | 'keyboard' | 'gamepad';
type Props = {
  active: boolean;
  send: (state: ControllerSnapshot) => void;
  onDeviceChange?: (device: InputDevice) => void;
  onModeChange?: (mode: InputMode, device: InputDevice) => void;
};

const KEYBOARD_GRACE_MS = 1500;

/**
 * Keyboard-first automatic input with an explicit manual fallback.
 * F8: lock the opposite source (Keyboard <-> Gamepad).
 * F9: restore Auto, with Keyboard as initial source.
 * Only the currently selected source ever sends input snapshots.
 */
export function BrowserController({ active: enabled, send, onDeviceChange, onModeChange }: Props) {
  const sendRef = useRef(send);
  const changedRef = useRef(onDeviceChange);
  const modeRef = useRef(onModeChange);
  sendRef.current = send;
  changedRef.current = onDeviceChange;
  modeRef.current = onModeChange;

  useEffect(() => {
    if (!enabled) {
      changedRef.current?.('keyboard');
      return;
    }

    let device: InputDevice = 'keyboard';
    let mode: InputMode = 'auto';
    let selectedPad: number | null = null;
    let lastIdle = 0;
    let lastKeyboardActivity = performance.now();
    const keys = new Set<string>();
    const activity = new Map<number, GamepadActivity>();
    changedRef.current?.('keyboard');

    function standardPads(): Gamepad[] {
      return Array.from(navigator.getGamepads?.() ?? [])
        .filter((pad): pad is Gamepad => pad !== null && pad.connected && pad.mapping === 'standard');
    }

    // Rebaseline all reported pads to avoid virtual feedback being interpreted
    // as a fresh gamepad press immediately after keyboard activity.
    function rebaselinePads() {
      for (const pad of standardPads()) activity.set(pad.index, observedPad(pad));
    }

    function switchTo(next: InputDevice, padIndex: number | null = null) {
      if (device === next && (next !== 'gamepad' || selectedPad === padIndex)) return;
      sendRef.current(neutralState());
      keys.clear();
      device = next;
      selectedPad = next === 'gamepad' ? padIndex : null;
      if (next === 'keyboard') rebaselinePads();
      changedRef.current?.(next);
    }

    function changeMode(next: InputMode) {
      const previousMode = mode;
      mode = next;
      if (next === 'auto') {
        switchTo('keyboard');
        lastKeyboardActivity = performance.now();
      } else if (next === 'keyboard') {
        switchTo('keyboard');
      } else {
        const pads = standardPads();
        const preferred = pads.find(pad => pad.index === selectedPad) ?? pads[0];
        switchTo('gamepad', preferred?.index ?? null);
      }
      if (mode !== previousMode) modeRef.current?.(mode, device);
    }

    function clear() {
      keys.clear();
      sendRef.current(neutralState());
      activity.clear();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.code === 'F8' || event.code === 'F9') {
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const target = event.target;
        if (target instanceof HTMLElement &&
            (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
        event.preventDefault();
        if (event.repeat) return;
        if (event.code === 'F9') changeMode('auto');
        else changeMode(device === 'keyboard' ? 'gamepad' : 'keyboard');
        return;
      }
      if (!controlKeys.has(event.code) || event.ctrlKey || event.altKey || event.metaKey ||
          document.hidden || !document.hasFocus()) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) return;
      event.preventDefault();
      // A mapped keyboard key establishes priority even in the event of
      // gamepad feedback occurring in the same frame.
      if (mode === 'auto' || mode === 'keyboard') {
        lastKeyboardActivity = performance.now();
        if (mode === 'auto' && device !== 'keyboard') switchTo('keyboard');
        if (!event.repeat) keys.add(event.code);
        rebaselinePads();
        sendRef.current(keyboardState(keys));
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (!controlKeys.has(event.code)) return;
      if (keys.has(event.code)) {
        event.preventDefault();
        keys.delete(event.code);
        lastKeyboardActivity = performance.now();
        if (device === 'keyboard') sendRef.current(keyboardState(keys));
        rebaselinePads();
      }
    }

    function onVisibility() {
      if (document.hidden) clear();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVisibility);

    const timer = window.setInterval(() => {
      if (document.hidden || !document.hasFocus()) return;
      const pads = standardPads();
      const present = new Set(pads.map(pad => pad.index));
      for (const index of activity.keys()) {
        if (!present.has(index)) activity.delete(index);
      }

      const protectedKeyboard = keys.size > 0 ||
        performance.now() - lastKeyboardActivity < KEYBOARD_GRACE_MS;
      for (const pad of pads) {
        const previous = activity.get(pad.index);
        if (!previous) {
          activity.set(pad.index, observedPad(pad));
          continue;
        }
        // During keyboard ownership, track virtual-gamepad state so that it
        // cannot become a delayed gamepad switch when the grace period ends.
        if (protectedKeyboard && mode === 'auto') {
          activity.set(pad.index, observedPad(pad));
          continue;
        }
        const intentional = freshGamepadInput(pad, previous);
        rememberButtons(pad, previous);
        if (mode === 'auto' && intentional && (device !== 'gamepad' || selectedPad !== pad.index)) {
          switchTo('gamepad', pad.index);
        }
        if (!intentional && device !== 'gamepad') {
          pad.axes.forEach((value, index) => {
            if (Math.abs(value) < 0.18) previous.referenceAxes[index] = value;
          });
        }
      }

      const selected = pads.find(pad => pad.index === selectedPad);
      if (device === 'gamepad' && !selected) {
        if (mode === 'auto') switchTo('keyboard');
        else if (mode === 'gamepad' && pads.length > 0) switchTo('gamepad', pads[0].index);
        else if (mode === 'gamepad') selectedPad = null; // Keep explicit manual gamepad mode.
      }
      if (device === 'gamepad' && selectedPad === null && mode === 'gamepad' && pads.length > 0) {
        selectedPad = pads[0].index;
      }

      const currentPad = pads.find(pad => pad.index === selectedPad);
      const state = device === 'gamepad' && currentPad
        ? gamepadState(currentPad)
        : device === 'keyboard' ? keyboardState(keys) : neutralState();
      const now = performance.now();
      if (active(state) || now - lastIdle >= 500) {
        sendRef.current(state);
        if (!active(state)) lastIdle = now;
      }
    }, 1000 / 60);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibility);
      clear();
    };
  }, [enabled]);

  return null;
}
