import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Fullscreen, LoaderCircle, MonitorPlay, Play, ScreenShare, ShieldCheck, StopCircle, X } from 'lucide-react';
import { api, type HostRoom, type RoomData } from './api';
import { hostVdoUrl, viewerVdoUrl } from './vdo';

type Mode = 'home' | 'host' | 'viewer';
const HOST_KEY = 'yukmain-active-host';

function loadHost(): HostRoom | null {
  try {
    const raw = sessionStorage.getItem(HOST_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as HostRoom;
    if (!/^\d{6}$/.test(value.code) || !/^[a-f0-9]{40}$/.test(value.streamId) || !/^[a-f0-9]{64}$/.test(value.hostToken) || Date.parse(value.expiresAt) < Date.now()) return null;
    return { ...value, status: 'preparing' };
  } catch { return null; }
}
const initialHost = loadHost();

function inviteUrl(code: string) {
  const url = new URL(window.location.origin);
  url.searchParams.set('code', code);
  return url.toString();
}
function prettyCode(code: string) { return code.slice(0, 3) + ' ' + code.slice(3); }
function Logo() { return <div className="brand"><MonitorPlay size={26}/> <span>Yuk<b>Main</b>.</span></div>; }

export default function App() {
  const [mode, setMode] = useState<Mode>(initialHost ? 'host' : 'home');
  const [host, setHost] = useState<HostRoom | null>(initialHost);
  const [viewer, setViewer] = useState<RoomData | null>(null);
  const [joinCode, setJoinCode] = useState(() => new URLSearchParams(window.location.search).get('code')?.replace(/\D/g, '').slice(0, 6) || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [captureVersion, setCaptureVersion] = useState(0);
  const [controls, setControls] = useState(true);
  const viewerRef = useRef<HTMLDivElement>(null);
  const autoJoined = useRef(false);

  const join = useCallback(async (code: string) => {
    if (!/^\d{6}$/.test(code)) { setError('Masukkan kode 6 digit.'); return; }
    setBusy(true); setError('');
    try {
      const room = await api.getRoom(code);
      setViewer(room);
      setMode('viewer');
      window.history.replaceState(null, '', '/?code=' + code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tidak dapat bergabung.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!initialHost && code && /^\d{6}$/.test(code) && !autoJoined.current) {
      autoJoined.current = true;
      void join(code);
    }
  }, [join]);

  useEffect(() => {
    if (!host) return;
    // A refreshed host browser needs a new screen-capture permission.
    if (host.status === 'preparing') void api.setLive(host, false).catch(() => {});
    const beat = () => void api.heartbeat(host).catch(() => setError('Koneksi host terputus.'));
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [host?.code, host?.hostToken]);

  useEffect(() => {
    if (mode !== 'viewer' || !viewer) return;
    const timer = setInterval(() => {
      void api.getRoom(viewer.code).then(room => {
        setViewer(prev => prev ? { ...prev, status: room.status } : prev);
      }).catch(() => {
        setViewer(null); setMode('home');
        window.history.replaceState(null, '', '/');
        setError('Room sudah berakhir atau host terputus.');
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [mode, viewer?.code]);

  async function create() {
    setBusy(true); setError('');
    try {
      const room = await api.createRoom();
      sessionStorage.setItem(HOST_KEY, JSON.stringify(room));
      setHost(room); setMode('host');
      window.history.replaceState(null, '', '/');
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal membuat room.'); }
    finally { setBusy(false); }
  }
  async function setLive(live: boolean) {
    if (!host) return;
    setBusy(true); setError('');
    try {
      const state = await api.setLive(host, live);
      const room = { ...host, status: state.status };
      setHost(room);
      sessionStorage.setItem(HOST_KEY, JSON.stringify(room));
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memperbarui siaran.'); }
    finally { setBusy(false); }
  }
  async function resetCapture() {
    if (!host) return;
    await setLive(false);
    setCaptureVersion(v => v + 1);
  }
  async function stop() {
    if (!host) return;
    setBusy(true);
    try {
      await api.closeRoom(host);
      sessionStorage.removeItem(HOST_KEY);
      setHost(null); setMode('home');
      window.history.replaceState(null, '', '/');
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal mengakhiri room.'); }
    finally { setBusy(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(''), 2000); }
    catch { setError('Tidak dapat menyalin. Silakan salin secara manual.'); }
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewerRef.current?.requestFullscreen();
    } catch { setError('Fullscreen ditolak browser. Coba tombol F11.'); }
  }
  function exitViewer() {
    setViewer(null); setMode('home'); setError('');
    window.history.replaceState(null, '', '/');
  }

  if (mode === 'viewer' && viewer) return (
    <div className="viewer" ref={viewerRef}>
      <iframe className="viewframe" src={viewerVdoUrl(viewer.streamId)} title="YukMain stream" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="no-referrer"/>
      {viewer.status !== 'live' && <div className="waiting"><div className="spinner"/><h2>Menunggu host membagikan layar</h2><p>Room {prettyCode(viewer.code)} siap. Stream akan muncul saat host mulai siaran.</p></div>}
      {controls ? <div className="viewer-ui">
        <div className="viewer-top"><Logo/><span className="pill">Room {prettyCode(viewer.code)}</span><button className="ghost" title="Sembunyikan kontrol" onClick={() => setControls(false)}><X size={19}/></button></div>
        <div className="viewer-bottom"><span className="live-label">{viewer.status === 'live' ? '● HOST LIVE' : '● MENUNGGU HOST'}</span><div className="buttons"><button className="secondary" onClick={fullscreen}><Fullscreen size={17}/> Fullscreen</button><button className="secondary" onClick={exitViewer}><ArrowLeft size={17}/> Keluar</button></div></div>
      </div> : <button className="reveal" onClick={() => setControls(true)}>Tampilkan kontrol</button>}
      {error && <div className="toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}
    </div>
  );

  return <div className="shell">
    <header><Logo/><span className="meta">● Browser only &nbsp; | &nbsp; Powered by VDO.Ninja</span></header>
    {error && <div className="toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}
    {mode === 'home' ? <main className="home">
      <section className="intro">
        <div className="eyebrow">● SHARE SCREEN • NONTON BARENG</div>
        <h1>Satu layar.<br/><em>Main bareng.</em></h1>
        <p>Bagikan tab, aplikasi, atau seluruh desktop kamu. Teman cukup memasukkan kode — langsung nonton, tanpa install apa pun.</p>
        <div className="benefits"><span><ShieldCheck size={17}/> Akses via kode</span><span>WebRTC realtime</span><span>Beda lokasi? Bisa.</span></div>
      </section>
      <div className="cards">
        <section className="card"><div className="square purple"><ScreenShare/></div><h2>Jadi Host</h2><p>Share layar kamu ke teman-teman.</p><button className="primary wide" disabled={busy} onClick={() => void create()}>{busy ? <LoaderCircle size={19}/> : <ScreenShare size={19}/>} Mulai Berbagi <ArrowRight size={18}/></button><small>Tanpa instal aplikasi desktop</small></section>
        <section className="card"><div className="square green"><Play/></div><h2>Gabung Nonton</h2><p>Masukkan kode dari host.</p><form className="join" onSubmit={e => {e.preventDefault(); void join(joinCode);}}><input aria-label="Kode room" inputMode="numeric" maxLength={6} placeholder="000000" value={joinCode} onChange={e=>setJoinCode(e.target.value.replace(/\D/g,'').slice(0,6))}/><button className="primary" type="submit" disabled={joinCode.length !== 6 || busy}><ArrowRight/></button></form><small>Hanya nonton, tanpa akses kontrol desktop.</small></section>
      </div>
    </main> : host && <main className="studio">
      <div className="studio-head"><div><button className="text-button" onClick={() => void stop()}><ArrowLeft size={16}/> Akhiri & kembali</button><h1>Studio Host <span className={'status ' + host.status}>{host.status === 'live' ? '● Live' : '● Menyiapkan'}</span></h1><p>Bagikan layar lewat browser kamu ke siapa saja yang punya kode.</p></div><button className="danger" onClick={() => void stop()} disabled={busy}><StopCircle size={17}/> Akhiri Room</button></div>
      <div className="studio-grid">
        <section className="panel"><div className="panel-head"><b>Screen sharing</b><small>LIVE PREVIEW</small></div><div className="capture-wrap"><iframe key={host.code + '-' + captureVersion} src={hostVdoUrl(host.streamId)} title="VDO.Ninja capture" allow="display-capture; autoplay; fullscreen; microphone; picture-in-picture" allowFullScreen referrerPolicy="no-referrer"/></div>
        <div className="instructions"><p><b>1.</b> Klik Share your Screen di panel, kemudian pilih Chrome Tab, Window, atau Entire Screen.</p><p><b>2.</b> Setelah layar terbagi, klik Tandai Siaran Aktif.</p></div>
        <div className="panel-actions"><button className="primary" disabled={busy} onClick={() => void setLive(host.status !== 'live')}>{host.status === 'live' ? 'Tandai Menyiapkan' : 'Tandai Siaran Aktif'}</button><button className="secondary" disabled={busy} onClick={() => void resetCapture()}>Pilih Ulang Layar</button><a href={hostVdoUrl(host.streamId)} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/> Buka VDO.Ninja</a></div></section>
        <aside className="side">
          <section className="panel room"><small>KODE ROOM KAMU</small><div className="room-code">{prettyCode(host.code)}</div><p>Bagikan kode ini agar teman bisa nonton.</p><button className="primary wide" onClick={()=>void copy(host.code,'code')}>{copied==='code' ? <Check size={17}/> : <Copy size={17}/>} {copied==='code'?'Kode tersalin':'Salin kode'}</button><button className="secondary wide" onClick={()=>void copy(inviteUrl(host.code),'link')}>{copied==='link' ? <Check size={17}/> : <Copy size={17}/>} {copied==='link'?'Link tersalin':'Salin link undangan'}</button></section>
          <section className="panel info"><h3><ShieldCheck size={18}/> Cara kerja YukMain</h3><p>✓ Host memilih sumber layar</p><p>✓ Penonton masuk memakai kode</p><p>✓ Penonton hanya bisa melihat</p><hr/><small>Room aktif maksimal 4 jam, dan berakhir jika host offline selama sekitar 90 detik.</small></section>
        </aside>
      </div>
    </main>}
    <footer>© YukMain · Simple screen sharing <span>Built for local testing</span></footer>
  </div>;
}
