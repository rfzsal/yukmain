import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserController, type ControllerSnapshot, type InputMode, type InputDevice } from './BrowserController';
import { Gamepad2, Keyboard, WifiOff } from 'lucide-react';

type JoinResult = { playerId: string; playerToken: string; slot: number; status: string; error?: string };
type Props = { roomCode: string };
function relayUrl(code: string, id: string) {
  const url = new URL(`/api/rooms/${code}/relay`, window.location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'player');
  url.searchParams.set('playerId', id);
  return url.toString();
}
export function QuickPlayGuest({ roomCode }: Props) {
  const [player, setPlayer] = useState<JoinResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [approved, setApproved] = useState(false);
  const [status, setStatus] = useState('Connecting controller…');
  const [device, setDevice] = useState<InputDevice>('keyboard');
  const [mode, setMode] = useState<InputMode>('auto');
  const [modeNotice, setModeNotice] = useState('');
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  const handleModeChange = useCallback((nextMode: InputMode, selected: InputDevice) => {
    setMode(nextMode);
    const notice = nextMode === 'auto' ? 'Auto detection · Keyboard ready'
      : nextMode === 'keyboard' ? 'Keyboard locked · F9 for Auto'
      : 'Gamepad locked · F9 for Auto';
    setModeNotice(notice);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setModeNotice(''), 2200);
    setDevice(selected);
  }, []);
  const [retry, setRetry] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    setPlayer(null);
    setConnected(false);
    setApproved(false);
    setStatus('Finding available controller…');
    seq.current = 0;

    async function connect() {
      try {
        let result = await fetch(`/api/rooms/${roomCode}/players/instant`, { method: 'POST', cache: 'no-store' });
        // When the host disables instant join, keep the same simple guest view
        // but use the existing manual host approval endpoint.
        if (result.status === 403) {
          result = await fetch(`/api/rooms/${roomCode}/players`, { method: 'POST', cache: 'no-store' });
        }
        const data = await result.json() as JoinResult;
        if (!result.ok) throw new Error(data.error ?? 'Unable to claim a controller');
        if (cancelled) return;
        setPlayer(data);
        setStatus(data.status === 'approved' ? 'Connecting…' : 'Waiting for host approval…');
        ws = new WebSocket(relayUrl(roomCode, data.playerId), [
          'yukmain.v1', `yukmain-player.${data.playerToken}`,
        ]);
        socket.current = ws;
        ws.onopen = () => { if (!cancelled) { setConnected(true);setApproved(data.status === 'approved');setStatus(data.status === 'approved' ? 'Connected' : 'Waiting for host approval…'); } };
        ws.onmessage = event => {
          try {
            const message = JSON.parse(String(event.data)) as { type: string; status?: string; slot?: number };
            if (cancelled) return;
            if (message.type === 'player.status') {
              if (message.status === 'approved') {
                setApproved(true);
                setStatus('Connected');
                setPlayer(p => p ? { ...p, slot: message.slot ?? p.slot, status: 'approved' } : p);
              } else if (message.status === 'pending') {
                setApproved(false);
                setStatus('Waiting for host approval…');
              } else if (message.status === 'rejected') {
                setApproved(false);
                setStatus('Controller access revoked');
                ws?.close();
              }
            }
          } catch { /* Ignore malformed non-controller messages. */ }
        };
        ws.onerror = () => { if (!cancelled) setStatus('Controller connection failed'); };
        ws.onclose = () => {
          if (!cancelled) {
            setConnected(false);
            setApproved(false);
            setStatus('Disconnected. Reconnect to play.');
          }
        };
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : 'Unable to connect');
      }
    }
    void connect();
    return () => { cancelled = true; ws?.close(); if (socket.current === ws) socket.current = null; };
  }, [roomCode, retry]);

  const send = useCallback((snapshot: ControllerSnapshot) => {
    if (!connected || !approved || !player || socket.current?.readyState !== WebSocket.OPEN) return;
    if (socket.current.bufferedAmount > 64 * 1024) return;
    seq.current += 1;
    socket.current.send(JSON.stringify({ type: 'controller.state', seq: seq.current, ...snapshot }));
  }, [connected, approved, player]);

  return <div className="quickplay-root">
    <div className="quickplay-badge" role="status" aria-live="polite">
      {connected && approved && player ?
        <>{device === 'gamepad' ? <Gamepad2 size={15}/> : <Keyboard size={15}/>}<b>P{player.slot}</b><span>Connected · {device === 'gamepad' ? 'Gamepad' : 'Keyboard'}{mode === 'auto' ? '' : ' (Manual)'}</span></> :
        <><WifiOff size={15}/><span>{status}</span></>}
    </div>
    {!connected && <button className="quickplay-retry" type="button"
      onClick={() => setRetry(v => v + 1)}>Retry connection</button>}
    {connected && approved && modeNotice && <div className="quickplay-mode-toast" role="status">{modeNotice}</div>}
    <BrowserController active={connected && approved} send={send} onDeviceChange={setDevice}
      onModeChange={handleModeChange}/>
  </div>;
}
