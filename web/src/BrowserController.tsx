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

// A deliberately higher threshold for *switching* devices than for playing:
// tiny analog drift must not steal control from the keyboard.
function intentionalGamepadInput(pad: Gamepad): boolean {
  return pad.buttons.some(button => button.pressed || button.value > 0.35) ||
    pad.axes.some(value => Number.isFinite(value) && Math.abs(value) > 0.4);
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
    const armedPads = new Map<number, boolean>();
    changedRef.current?.('keyboard');

    function switchTo(next: InputDevice, pad: number | null = null) {
      if (device === next && (next !== 'gamepad' || selectedPad === pad)) return;
      sendRef.current(neutralState());
      keys.clear();
      device = next;
      selectedPad = pad;
      changedRef.current?.(next);
    }
    function clear() {
      keys.clear();
      sendRef.current(neutralState());
      // Require a new physical actuation when the page returns.
      armedPads.clear();
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
      for (const index of armedPads.keys()) {
        if (!present.has(index)) armedPads.delete(index);
      }
      for (const pad of pads) {
        const intentional = intentionalGamepadInput(pad);
        const previouslyActive = armedPads.get(pad.index) ?? false;
        if (intentional && !previouslyActive && (device !== 'gamepad' || selectedPad !== pad.index)) {
          switchTo('gamepad', pad.index);
        }
        armedPads.set(pad.index, intentional);
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
