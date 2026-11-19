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

type Props = {
  active: boolean;
  send: (state: ControllerSnapshot) => void;
  onDeviceChange?: (device: InputDevice) => void;
};

/**
 * A single controller sender owns both input sources. Keyboard is always the
 * initial source. A fresh gamepad actuation or keyboard keydown changes it.
 * Source transitions release the previous input before sending the new one.
 */
export function BrowserController({ active: enabled, send, onDeviceChange }: Props) {
  const sendRef = useRef(send);
  const changedRef = useRef(onDeviceChange);
  sendRef.current = send;
  changedRef.current = onDeviceChange;

  useEffect(() => {
    if (!enabled) {
      changedRef.current?.('keyboard');
      return;
    }
    let device: InputDevice = 'keyboard';
    let selectedPad: number | null = null;
    let lastIdle = 0;
    const keys = new Set<string>();
    const activity = new Map<number, GamepadActivity>();
    changedRef.current?.('keyboard');

    function switchTo(next: InputDevice, pad: number | null = null) {
      if (device === next && (next !== 'gamepad' || selectedPad === pad)) return;
      sendRef.current(neutralState());
      keys.clear();
      if (next === 'keyboard') {
        // Treat all currently held physical inputs as the new baseline.
        // They cannot steal control back until the user moves/presses again.
        for (const pad of Array.from(navigator.getGamepads?.() ?? [])) {
          if (pad?.connected && pad.mapping === 'standard') activity.set(pad.index, observedPad(pad));
        }
      }
      device = next;
      selectedPad = pad;
      changedRef.current?.(next);
    }
    function clear() {
      keys.clear();
      sendRef.current(neutralState());
      // On focus return, establish a fresh baseline; do not interpret
      // currently held inputs or unusual idle axis values as user activity.
      activity.clear();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!controlKeys.has(event.code) || event.ctrlKey || event.altKey || event.metaKey ||
          document.hidden || !document.hasFocus()) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) return;
      event.preventDefault();
      if (event.repeat) return;
      if (device !== 'keyboard') switchTo('keyboard');
      keys.add(event.code);
      sendRef.current(keyboardState(keys));
    }
    function onKeyUp(event: KeyboardEvent) {
      if (!controlKeys.has(event.code)) return;
      if (device === 'keyboard' && keys.delete(event.code)) {
        event.preventDefault();
        sendRef.current(keyboardState(keys));
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
      const pads = Array.from(navigator.getGamepads?.() ?? [])
        .filter((pad): pad is Gamepad => pad !== null && pad.connected && pad.mapping === 'standard');
      const present = new Set(pads.map(pad => pad.index));
      for (const index of activity.keys()) {
        if (!present.has(index)) activity.delete(index);
      }
      for (const pad of pads) {
        const previous = activity.get(pad.index);
        if (!previous) {
          // Establish a baseline on connection rather than switching from
          // a pre-existing button press or an off-centre resting axis.
          activity.set(pad.index, observedPad(pad));
          continue;
        }
        const intentional = freshGamepadInput(pad, previous);
        rememberButtons(pad, previous);
        if (intentional && (device !== 'gamepad' || selectedPad !== pad.index)) {
          switchTo('gamepad', pad.index);
        }
        // A near-resting axis position is eligible to become the new origin;
        // don't continuously track significant movement or slow stick motion
        // would never exceed the gesture threshold.
        if (!intentional && device !== 'gamepad') {
          pad.axes.forEach((value, index) => {
            if (Math.abs(value) < 0.18) previous.referenceAxes[index] = value;
          });
        }
      }
      const selected = pads.find(pad => pad.index === selectedPad);
      if (device === 'gamepad' && !selected) switchTo('keyboard');

      const state = device === 'gamepad' && selected ? gamepadState(selected) : keyboardState(keys);
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
