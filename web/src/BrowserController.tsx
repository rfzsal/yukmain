import { useEffect, useRef, useState } from 'react';

export type ControllerSnapshot = {
  buttons: string[];
  dpad: string;
  leftStick: { x: number; y: number };
  rightStick: { x: number; y: number };
  leftTrigger: number;
  rightTrigger: number;
};

const neutral = (): ControllerSnapshot => ({
  buttons: [], dpad: 'none',
  leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 },
  leftTrigger: 0, rightTrigger: 0,
});

const keyboardButtons: Record<string, string> = {
  KeyJ: 'A', KeyK: 'B', KeyU: 'X', KeyI: 'Y',
  KeyQ: 'LB', KeyE: 'RB', Enter: 'Start',
  Backspace: 'Back', KeyZ: 'LS', KeyC: 'RS',
};
const heldKeys = new Set([...Object.keys(keyboardButtons),
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Digit1', 'Digit2']);

const clamp = (n: number) => Math.max(-1, Math.min(1, n));
function axis(n: number): number {
  if (!Number.isFinite(n) || Math.abs(n) < 0.14) return 0;
  return Math.round(clamp((n - Math.sign(n) * 0.14) / 0.86) * 1000) / 1000;
}
const magnitude = (s: ControllerSnapshot) =>
  s.buttons.length > 0 || s.dpad !== 'none' ||
  s.leftStick.x !== 0 || s.leftStick.y !== 0 ||
  s.rightStick.x !== 0 || s.rightStick.y !== 0 ||
  s.leftTrigger !== 0 || s.rightTrigger !== 0;

function fromKeyboard(keys: Set<string>): ControllerSnapshot {
  const s = neutral();
  s.buttons = Object.entries(keyboardButtons).filter(([key]) => keys.has(key)).map(([, name]) => name);
  const x = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
  const y = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
  const norm = Math.hypot(x, y) || 1;
  s.leftStick = { x: x / norm, y: y / norm };
  const up = keys.has('ArrowUp'), down = keys.has('ArrowDown');
  const left = keys.has('ArrowLeft'), right = keys.has('ArrowRight');
  const v = up === down ? '' : up ? 'up' : 'down';
  const h = left === right ? '' : left ? 'left' : 'right';
  s.dpad = [v, h].filter(Boolean).join('-') || 'none';
  s.leftTrigger = keys.has('Digit1') ? 1 : 0;
  s.rightTrigger = keys.has('Digit2') ? 1 : 0;
  return s;
}

function fromGamepad(pad: Gamepad): ControllerSnapshot {
  const s = neutral();
  const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', '', '', 'Back', 'Start', 'LS', 'RS'];
  s.buttons = names.filter((name, index) => name && pad.buttons[index]?.pressed);
  const up = !!pad.buttons[12]?.pressed, down = !!pad.buttons[13]?.pressed;
  const left = !!pad.buttons[14]?.pressed, right = !!pad.buttons[15]?.pressed;
  const v = up === down ? '' : up ? 'up' : 'down';
  const h = left === right ? '' : left ? 'left' : 'right';
  s.dpad = [v, h].filter(Boolean).join('-') || 'none';
  s.leftStick = { x: axis(pad.axes[0] ?? 0), y: axis(pad.axes[1] ?? 0) };
  s.rightStick = { x: axis(pad.axes[2] ?? 0), y: axis(pad.axes[3] ?? 0) };
  s.leftTrigger = Math.max(0, Math.min(1, pad.buttons[6]?.value ?? 0));
  s.rightTrigger = Math.max(0, Math.min(1, pad.buttons[7]?.value ?? 0));
  return s;
}

type Props = { active: boolean; send: (state: ControllerSnapshot) => void };
export function BrowserController({ active, send }: Props) {
  const [device, setDevice] = useState<'keyboard' | 'gamepad'>('keyboard');
  const [gamepads, setGamepads] = useState<{ index: number; name: string }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const keys = useRef(new Set<string>());
  const sender = useRef(send);
  sender.current = send;

  useEffect(() => {
    const refresh = () => {
      const pads = Array.from(navigator.getGamepads?.() ?? [])
        .filter((pad): pad is Gamepad => pad !== null && pad.connected && pad.mapping === 'standard')
        .map(pad => ({ index: pad.index, name: pad.id }));
      setGamepads(pads);
      setSelected(previous => previous !== null && pads.some(p => p.index === previous)
        ? previous : pads[0]?.index ?? null);
    };
    refresh();
    window.addEventListener('gamepadconnected', refresh);
    window.addEventListener('gamepaddisconnected', refresh);
    return () => {
      window.removeEventListener('gamepadconnected', refresh);
      window.removeEventListener('gamepaddisconnected', refresh);
    };
  }, []);

  useEffect(() => {
    if (!active || device !== 'keyboard') { keys.current.clear(); return; }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!heldKeys.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return;
      event.preventDefault();
      keys.current.add(event.code);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!heldKeys.has(event.code)) return;
      keys.current.delete(event.code);
      event.preventDefault();
    };
    const clear = () => { keys.current.clear(); sender.current(neutral()); };
    const onVisibility = () => { if (document.hidden) clear(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clear();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, device]);

  useEffect(() => {
    if (!active) return;
    let lastIdle = 0;
    const timer = window.setInterval(() => {
      const pad = selected === null ? null : navigator.getGamepads?.()[selected] ?? null;
      const state = device === 'gamepad' && pad?.connected && pad.mapping === 'standard'
        ? fromGamepad(pad) : device === 'keyboard' ? fromKeyboard(keys.current) : neutral();
      const now = performance.now();
      // 60 Hz when a control is held; low-rate neutral snapshots otherwise.
      if (magnitude(state) || now - lastIdle >= 500) {
        sender.current(document.hidden ? neutral() : state);
        if (!magnitude(state)) lastIdle = now;
      }
    }, 1000 / 60);
    return () => { window.clearInterval(timer); sender.current(neutral()); };
  }, [active, device, selected]);

  return <div className="browser-controller">
    <strong>Playable controller</strong>
    <small>Input is sent only after the host approves your P2/P3/P4 slot.</small>
    <div className="controller-devices">
      <button className="secondary" type="button" aria-pressed={device === 'keyboard'}
        onClick={() => setDevice('keyboard')}>Keyboard</button>
      <button className="secondary" type="button" aria-pressed={device === 'gamepad'}
        onClick={() => setDevice('gamepad')}>Physical gamepad</button>
    </div>
    {device === 'keyboard' ?
      <small>WASD: left stick · Arrows: D-pad · J/K/U/I: A/B/X/Y · Q/E: LB/RB · 1/2: LT/RT · Enter: Start · Backspace: Back · Z/C: stick clicks</small> :
      <div>
        <label htmlFor="yukmain-gamepad">Connected gamepad</label>
        <select id="yukmain-gamepad" value={selected ?? ''} onChange={event => setSelected(Number(event.target.value))}>
          {gamepads.length === 0 && <option value="">Connect a controller and press any button</option>}
          {gamepads.map(pad => <option key={pad.index} value={pad.index}>{pad.name}</option>)}
        </select>
        <small>Standard-mapped controllers only. Press a gamepad button if your browser has not detected it.</small>
      </div>}
    <small role="status">{active ? 'Controller active · inputs are being streamed' : 'Waiting for host approval / WebSocket connection'}</small>
  </div>;
}
