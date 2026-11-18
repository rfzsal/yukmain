import { useCallback, useEffect, useRef, useState } from 'react';

type Role = 'host' | 'player';
type Player = { id: string; status: string; slot: number; connected: boolean };
type RelayEvent = {
  type: string;
  role?: string;
  room?: string;
  playerId?: string;
  slot?: number;
  status?: string;
  seq?: number;
  buttons?: string[];
  reason?: string;
};
type Props = { role: Role; roomCode: string; hostToken?: string };

function socketUrl(roomCode: string, role: Role, playerId?: string): string {
  const url = new URL(`/api/rooms/${roomCode}/relay`, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  if (playerId) url.searchParams.set('playerId', playerId);
  return url.toString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RelayDebugPanel({ role, roomCode, hostToken }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [playerToken, setPlayerToken] = useState('');
  const [slot, setSlot] = useState(0);
  const [status, setStatus] = useState('disconnected');
  const [players, setPlayers] = useState<Player[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);

  const log = useCallback((text: string) => {
    setEvents(previous => [`${new Date().toLocaleTimeString()} · ${text}`, ...previous].slice(0, 16));
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/relay/config', { cache: 'no-store' })
      .then(async response => response.ok ? response.json() as Promise<{ enabled: boolean }> : { enabled: false })
      .then(config => { if (active) setEnabled(config.enabled === true); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!enabled || role !== 'host' || !hostToken) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/rooms/${roomCode}/players`, {
          headers: { Authorization: `Bearer ${hostToken}` },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { players: Player[] };
        if (active) setPlayers(body.players);
      } catch (error) {
        if (active) log(`Could not load player requests: ${messageOf(error)}`);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled, role, roomCode, hostToken, log]);

  useEffect(() => {
    if (!enabled) return;
    if (role === 'host' && !hostToken) return;
    if (role === 'player' && (!playerToken || !playerId)) return;

    const token = role === 'host' ? hostToken! : playerToken;
    const ws = new WebSocket(socketUrl(roomCode, role, role === 'player' ? playerId : undefined), [
      'yukmain.v1',
      `yukmain-${role}.${token}`,
    ]);
    socketRef.current = ws;
    setStatus('connecting');
    ws.onopen = () => {
      setConnected(true);
      log('WebSocket connected');
    };
    ws.onmessage = event => {
      try {
        const packet = JSON.parse(String(event.data)) as RelayEvent;
        if (packet.type === 'player.status' && role === 'player') {
          setStatus(packet.status ?? 'pending');
          setSlot(packet.slot ?? 0);
        } else if (packet.type === 'controller.state') {
          log(`P${packet.slot}: ${packet.buttons?.join(', ') || 'neutral'} · seq ${packet.seq}`);
        } else if (packet.type === 'controller.neutral') {
          log(`P${packet.slot}: neutral reset`);
        } else if (packet.type === 'connection.ready') {
          log(`Authenticated as ${packet.role}`);
          if (role === 'host') setStatus('connected');
        } else if (packet.type === 'input.rejected') {
          log(`Input rejected: ${packet.reason}`);
        } else {
          log(`${packet.type}${packet.playerId ? ` · ${packet.playerId}` : ''}`);
        }
      } catch {
        log('Malformed server message');
      }
    };
    ws.onerror = () => log('WebSocket error (check authentication, reverse proxy, and server logs)');
    ws.onclose = event => {
      setConnected(false);
      setStatus(event.code === 1000 ? 'disconnected' : `disconnected (${event.code})`);
      log(`WebSocket closed (${event.code})`);
    };
    return () => {
      if (socketRef.current === ws) socketRef.current = null;
      ws.close();
    };
  }, [enabled, role, roomCode, hostToken, playerId, playerToken, log]);

  async function requestControl() {
    try {
      const response = await fetch(`/api/rooms/${roomCode}/players`, { method: 'POST' });
      const payload = await response.json() as {
        playerId?: string;
        playerToken?: string;
        error?: string;
      };
      if (!response.ok || !payload.playerId || !payload.playerToken) {
        throw new Error(payload.error ?? 'Unable to register player');
      }
      setPlayerId(payload.playerId);
      setPlayerToken(payload.playerToken);
      setStatus('pending');
      log('Control requested; waiting for host approval');
    } catch (error) {
      log(`Player registration failed: ${messageOf(error)}`);
    }
  }

  async function decide(id: string, approved: boolean, requestedSlot: number) {
    try {
      const response = await fetch(`/api/rooms/${roomCode}/players/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${hostToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, slot: approved ? requestedSlot : 0 }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setPlayers(previous => previous.map(p => p.id === id ?
        { ...p, status: approved ? 'approved' : 'rejected', slot: approved ? requestedSlot : 0 } : p));
      log(`${approved ? 'Approved' : 'Rejected'} player ${id} ${approved ? `for P${requestedSlot}` : ''}`);
    } catch (error) { log(`Approval failed: ${messageOf(error)}`); }
  }

  function input(buttons: string[]) {
    if (!connected || status !== 'approved' || socketRef.current?.readyState !== WebSocket.OPEN) return;
    seqRef.current += 1;
    socketRef.current.send(JSON.stringify({
      type: 'controller.state', seq: seqRef.current, buttons, dpad: 'none',
      leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 },
      leftTrigger: 0, rightTrigger: 0,
    }));
    log(`P${slot}: sent ${buttons.join(', ') || 'neutral'} · seq ${seqRef.current}`);
  }

  if (!enabled) return null;

  return <section className="relay-debug">
    <div className="relay-debug-head">
      <strong>WebSocket Relay Debug · {role === 'host' ? 'Host Receiver' : 'Remote Player'}</strong>
      <span className={connected ? 'relay-online' : 'relay-offline'}>{connected ? '● Connected' : '○ Disconnected'}</span>
    </div>
    <p>Testing only · WebSocket state relay · No Windows controller connected</p>
    {role === 'host' ? <>
      <div className="relay-debug-players">
        <strong>Control requests</strong>
        {players.length === 0 && <small>No requests yet. Join this room from another browser.</small>}
        {players.map(p => <div className="relay-debug-player" key={p.id}>
          <span>{p.id.slice(0, 8)} · {p.status} {p.slot ? `(P${p.slot})` : ''} {p.connected ? '· online' : ''}</span>
          <div>
            {([2, 3, 4] as const).map(n =>
              <button className="secondary" key={n} onClick={() => void decide(p.id, true, n)}>P{n}</button>)}
            <button className="secondary" onClick={() => void decide(p.id, false, 0)}>Reject</button>
          </div>
        </div>)}
      </div>
    </> : <>
      <div className="relay-debug-player">
        <span>Status: {status} {slot ? `· P${slot}` : ''}</span>
        {!playerToken && <button className="secondary" onClick={() => void requestControl()}>Request controller</button>}
      </div>
      <div className="relay-debug-buttons">
        <button className="secondary" disabled={!connected || status !== 'approved'}
                onClick={() => input(['A'])}>Press A</button>
        <button className="secondary" disabled={!connected || status !== 'approved'}
                onClick={() => input([])}>Release all</button>
      </div>
    </>}
    <div className="relay-debug-log" aria-live="polite">
      {events.length === 0 ? <small>Awaiting WebSocket events...</small> : events.map((event, i) => <div key={i}>{event}</div>)}
    </div>
  </section>;
}
