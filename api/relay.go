package main

import (
    "crypto/sha256"
    "crypto/subtle"
    "encoding/json"
    "net/http"
    "net/url"
    "strings"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// Phase 2 keeps the room API and controller relay in one Go process.
// All room/participant state is guarded by server.mu. Network writes happen
// outside that lock so a slow browser never blocks other rooms.

type relayPlayer struct {
    ID string
    TokenHash [32]byte
    Approved bool
    Slot int
    Conn *relayConn
    LastSeq uint64
    RateStart time.Time
    Frames int
    Instant bool
    JoinDeadline time.Time
}

type relayConn struct {
    socket *websocket.Conn
    writeMu sync.Mutex
}

func (c *relayConn) send(value any) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    _ = c.socket.SetWriteDeadline(time.Now().Add(4*time.Second))
    return c.socket.WriteJSON(value)
}

func (c *relayConn) close() {
    _ = c.socket.Close()
}

type controllerState struct {
    Type string `json:"type"`
    Seq uint64 `json:"seq"`
    Buttons []string `json:"buttons"`
    DPad string `json:"dpad"`
    LeftStick axisPair `json:"leftStick"`
    RightStick axisPair `json:"rightStick"`
    LeftTrigger float64 `json:"leftTrigger"`
    RightTrigger float64 `json:"rightTrigger"`
}

type axisPair struct {
    X float64 `json:"x"`
    Y float64 `json:"y"`
}

var permittedButtons = map[string]bool{
    "A":true, "B":true, "X":true, "Y":true,
    "LB":true, "RB":true, "Start":true, "Back":true,
    "LS":true, "RS":true, "Guide":true,
}

var permittedDPad = map[string]bool{
    "":true, "none":true, "up":true, "up-right":true,
    "right":true, "down-right":true, "down":true,
    "down-left":true, "left":true, "up-left":true,
}

func (state controllerState) validate() bool {
    if state.Type != "controller.state" || !permittedDPad[state.DPad] || len(state.Buttons)>11 {
        return false
    }
    seen := make(map[string]bool, len(state.Buttons))
    for _, button := range state.Buttons {
        if !permittedButtons[button] || seen[button] { return false }
        seen[button] = true
    }
    validAxis := func(v float64) bool { return v>=-1 && v<=1 }
    return validAxis(state.LeftStick.X) && validAxis(state.LeftStick.Y) &&
        validAxis(state.RightStick.X) && validAxis(state.RightStick.Y) &&
        state.LeftTrigger>=0 && state.LeftTrigger<=1 &&
        state.RightTrigger>=0 && state.RightTrigger<=1
}

func (s *server) registerPlayer(w http.ResponseWriter, r *http.Request) {
    if !s.allow(r, "relay-register", 15, time.Minute) {
        writeError(w, http.StatusTooManyRequests, "Too many control requests.")
        return
    }
    code := r.PathValue("code")
    if !validCode(code) { writeError(w, 400, "Invalid room code."); return }
    token, err := secureHex(32)
    if err != nil { writeError(w, 500, "Could not create player."); return }
    id, err := secureHex(8)
    if err != nil { writeError(w, 500, "Could not create player."); return }

    s.mu.Lock()
    entry, ok := s.rooms[code]
    if !ok || !s.isAvailable(entry, s.now()) {
        s.mu.Unlock()
        writeError(w, 404, "Room not available.")
        return
    }
    if entry.Players == nil { entry.Players = make(map[string]*relayPlayer) }
    if len(entry.Players) >= 12 {
        s.mu.Unlock()
        writeError(w, 429, "Room has too many player requests.")
        return
    }
    entry.Players[id] = &relayPlayer{ID:id, TokenHash:sha256.Sum256([]byte(token))}
    host := entry.HostWS
    s.mu.Unlock()
    if host!=nil { _ = host.send(map[string]any{"type":"player.pending","playerId":id}) }
    writeJSON(w, 201, map[string]any{"playerId":id,"playerToken":token,"status":"pending"})
}

func (s *server) listPlayers(w http.ResponseWriter, r *http.Request) {
    s.mu.Lock()
    entry, ok := s.authorizedRoom(r)
    if !ok { s.mu.Unlock(); writeError(w, 404, "Room not found or access denied."); return }
    players := make([]map[string]any, 0, len(entry.Players))
    for _, p := range entry.Players {
        status := "pending"
        if p.Approved { status = "approved" }
        players = append(players, map[string]any{
            "id":p.ID, "status":status, "slot":p.Slot, "connected":p.Conn!=nil,
        })
    }
    s.mu.Unlock()
    writeJSON(w, 200, map[string]any{"players":players})
}

func (s *server) approvePlayer(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 1024)
    var decision struct {
        Approved bool `json:"approved"`
        Slot int `json:"slot"`
    }
    if json.NewDecoder(r.Body).Decode(&decision)!=nil ||
       (decision.Approved && (decision.Slot<2 || decision.Slot>4)) {
        writeError(w, 400, "Invalid approval decision."); return
    }
    s.mu.Lock()
    entry, ok := s.authorizedRoom(r)
    if !ok { s.mu.Unlock(); writeError(w, 404, "Room not found or access denied."); return }
    player := entry.Players[r.PathValue("id")]
    if player==nil { s.mu.Unlock(); writeError(w, 404, "Player not found."); return }
    if decision.Approved {
        for id, other := range entry.Players {
            if id!=player.ID && other.Approved && other.Slot==decision.Slot {
                s.mu.Unlock()
                writeError(w, 409, "Player slot already occupied."); return
            }
        }
    }
    previous := player.Slot
    player.Approved = decision.Approved
    if decision.Approved { player.Slot=decision.Slot } else { player.Slot=0 }
    player.LastSeq=0
    player.Frames=0
    player.RateStart=time.Time{}
    host := entry.HostWS
    peer := player.Conn
    slot := player.Slot
    s.mu.Unlock()

    if host!=nil && previous!=0 { _=host.send(map[string]any{"type":"controller.neutral","slot":previous,"playerId":player.ID}) }
    status:="rejected"
    if decision.Approved { status="approved" }
    event:=map[string]any{"type":"player.status","status":status,"slot":slot}
    if peer!=nil { _=peer.send(event) }
    if host!=nil { _=host.send(map[string]any{"type":"player.status","playerId":player.ID,"status":status,"slot":slot}) }
    writeJSON(w, 200, map[string]any{"status":status,"slot":slot})
}

func matchingOrigin(r *http.Request) bool {
    origin := r.Header.Get("Origin")
    if origin=="" { return true } // Non-browser clients still require a valid token.
    parsed, err := url.Parse(origin)
    return err==nil && (parsed.Scheme=="https" || parsed.Scheme=="http") && strings.EqualFold(parsed.Host, r.Host)
}

var relayUpgrader = websocket.Upgrader{
    ReadBufferSize:1024, WriteBufferSize:1024,
    Subprotocols:[]string{"yukmain.v1"},
    CheckOrigin:matchingOrigin,
}

func protocolToken(r *http.Request, role string) string {
    prefix:="yukmain-"+role+"."
    for _, proto := range websocket.Subprotocols(r) {
        if strings.HasPrefix(proto,prefix) { return strings.TrimPrefix(proto,prefix) }
    }
    return ""
}

func (s *server) relaySocket(w http.ResponseWriter, r *http.Request) {
    code:=r.PathValue("code")
    role:=r.URL.Query().Get("role")
    if !validCode(code) || (role!="host" && role!="player" && role!="agent") {
        writeError(w, 400, "Invalid room or role."); return
    }
    token:=protocolToken(r,role)
    if len(token)!=64 {
        writeError(w,401,"Invalid connection credential."); return
    }
    hash:=sha256.Sum256([]byte(token))
    playerID:=r.URL.Query().Get("playerId")

    s.mu.Lock()
    entry,exists:=s.rooms[code]
    if !exists || !s.isAvailable(entry,s.now()) {
        s.mu.Unlock(); writeError(w,404,"Room unavailable."); return
    }
    var player *relayPlayer
    if role=="host" || role=="agent" {
        expected:=entry.HostTokenHash
        if role=="agent" {
            expected=entry.AgentTokenHash
            if expected==[32]byte{} {
                s.mu.Unlock(); writeError(w,401,"Agent not paired."); return
            }
        }
        if subtle.ConstantTimeCompare(hash[:],expected[:])!=1 {
            s.mu.Unlock(); writeError(w,401,"Unauthorized."); return
        }
        if entry.HostWS!=nil {
            if role=="agent" && entry.HostKind=="host" {
                // The paired Windows Agent takes priority over the browser debug receiver.
                entry.HostWS.close()
                entry.HostWS=nil
                entry.HostKind=""
            } else {
                s.mu.Unlock(); writeError(w,409,"Host receiver already connected."); return
            }
        }
    } else {
        player=entry.Players[playerID]
        if player!=nil && player.Instant && player.Conn==nil && s.now().After(player.JoinDeadline) {
            delete(entry.Players,playerID)
            player=nil
        }
        if player==nil || subtle.ConstantTimeCompare(hash[:],player.TokenHash[:])!=1 {
            s.mu.Unlock(); writeError(w,401,"Unauthorized."); return
        }
        if player.Conn!=nil {
            s.mu.Unlock(); writeError(w,409,"Player already connected."); return
        }
    }

    // Hold the room lock through upgrade, preventing concurrent duplicate upgrades.
    ws,err:=relayUpgrader.Upgrade(w,r,nil)
    if err!=nil { s.mu.Unlock(); return }
    conn:=&relayConn{socket:ws}
    if role=="host" || role=="agent" {
        entry.HostWS=conn
        entry.HostKind=role
    } else { player.Conn=conn }
    s.mu.Unlock()

    defer func() {
        s.mu.Lock()
        if role=="host" || role=="agent" {
            if entry.HostWS==conn { entry.HostWS=nil; entry.HostKind="" }
        }
        host:=entry.HostWS
        wasApproved:=player!=nil && player.Approved
        slot:=0
        if player!=nil { slot=player.Slot }
        if player!=nil && player.Conn==conn {
            player.Conn=nil
            // Release disconnected slots for both manual and instant players.
            // The old manual player record remains pending for host reapproval.
            player.Approved=false
            player.Slot=0
            if player.Instant { delete(entry.Players,player.ID) }
        }
        s.mu.Unlock()
        if player!=nil && wasApproved && host!=nil {
            _=host.send(map[string]any{"type":"controller.neutral","slot":slot,"playerId":player.ID})
            _=host.send(map[string]any{"type":"player.disconnected","slot":slot,"playerId":player.ID})
        }
        conn.close()
    }()

    ws.SetReadLimit(2048)
    _=ws.SetReadDeadline(time.Now().Add(50*time.Second))
    ws.SetPongHandler(func(string) error {
        return ws.SetReadDeadline(time.Now().Add(50*time.Second))
    })

    _=conn.send(map[string]any{"type":"connection.ready","role":role,"room":code})
    if player!=nil {
        status:="pending"
        if player.Approved { status="approved" }
        _=conn.send(map[string]any{"type":"player.status","status":status,"slot":player.Slot})
    }

    done:=make(chan struct{})
    go func() {
        ticker:=time.NewTicker(20*time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-done: return
            case <-ticker.C:
                conn.writeMu.Lock()
                _=ws.WriteControl(websocket.PingMessage,nil,time.Now().Add(4*time.Second))
                conn.writeMu.Unlock()
            }
        }
    }()
    defer close(done)

    for {
        _,payload,err:=ws.ReadMessage()
        if err!=nil { return }
        if role=="host" || role=="agent" { continue } // Receivers never inject inputs.
        var state controllerState
        if json.Unmarshal(payload,&state)!=nil || !state.validate() {
            _=conn.send(map[string]any{"type":"input.rejected","reason":"invalid_state"})
            continue
        }
        s.mu.Lock()
        authorized:=player.Approved && player.Conn==conn && entry.HostWS!=nil &&
            s.isAvailable(entry,s.now())
        if state.Seq==0 || state.Seq<=player.LastSeq { authorized=false }
        now:=s.now()
        if now.Sub(player.RateStart)>=time.Second {
            player.RateStart=now
            player.Frames=0
        }
        if player.Frames>=90 { authorized=false }
        var host *relayConn
        var slot int
        if authorized {
            player.Frames++
            player.LastSeq=state.Seq
            host=entry.HostWS
            slot=player.Slot
        }
        s.mu.Unlock()
        if !authorized {
            _=conn.send(map[string]any{"type":"input.rejected","reason":"not_authorized_or_stale"})
            continue
        }
        // Forward the exact validated state, plus server-assigned identity.
        if host!=nil {
            if err:=host.send(map[string]any{
                "type":"controller.state","slot":slot,"playerId":player.ID,
                "seq":state.Seq,"buttons":state.Buttons,"dpad":state.DPad,
                "leftStick":state.LeftStick,"rightStick":state.RightStick,
                "leftTrigger":state.LeftTrigger,"rightTrigger":state.RightTrigger,
            }); err!=nil {
                _=conn.send(map[string]any{"type":"input.rejected","reason":"host_unavailable"})
            }
        }
    }
}

func (s *server) closeRelay(entry *room) {
    if entry.HostWS!=nil { entry.HostWS.close(); entry.HostWS=nil }
    for _, player:=range entry.Players {
        if player.Conn!=nil { player.Conn.close(); player.Conn=nil }
    }
}


func (s *server) instantJoinSettings(w http.ResponseWriter,r *http.Request) {
    s.mu.Lock()
    entry,ok:=s.authorizedRoom(r)
    if !ok {s.mu.Unlock();writeError(w,404,"Room unavailable or unauthorized.");return}
    enabled:=entry.InstantJoinEnabled
    s.mu.Unlock()
    writeJSON(w,200,map[string]bool{"enabled":enabled})
}

func (s *server) setInstantJoin(w http.ResponseWriter,r *http.Request) {
    r.Body=http.MaxBytesReader(w,r.Body,1024)
    var payload struct{ Enabled *bool `json:"enabled"` }
    if json.NewDecoder(r.Body).Decode(&payload)!=nil || payload.Enabled==nil {
        writeError(w,400,"Invalid controller setting.");return
    }
    s.mu.Lock()
    entry,ok:=s.authorizedRoom(r)
    if !ok {s.mu.Unlock();writeError(w,404,"Room unavailable or unauthorized.");return}
    entry.InstantJoinEnabled=*payload.Enabled
    s.mu.Unlock()
    writeJSON(w,200,map[string]bool{"enabled":*payload.Enabled})
}

// Instant controller slots are atomically assigned and guarded by a short
// connection lease; abandoned HTTP claims cannot reserve a controller forever.
func (s *server) instantJoin(w http.ResponseWriter,r *http.Request) {
    if !s.allow(r,"instant-join",12,time.Minute) {
        writeError(w,429,"Too many join attempts.");return
    }
    code:=r.PathValue("code")
    if !validCode(code) {writeError(w,400,"Invalid room.");return}
    token,err:=secureHex(32)
    if err!=nil {writeError(w,500,"Unable to create player.");return}
    id,err:=secureHex(8)
    if err!=nil {writeError(w,500,"Unable to create player.");return}
    s.mu.Lock()
    entry,ok:=s.rooms[code]
    if !ok || !s.isAvailable(entry,s.now()) {
        s.mu.Unlock();writeError(w,404,"Room unavailable.");return
    }
    if !entry.InstantJoinEnabled {
        s.mu.Unlock();writeError(w,403,"Host has not enabled instant controllers.");return
    }
    if entry.HostWS==nil || entry.HostKind!="agent" {
        s.mu.Unlock();writeError(w,409,"Windows Host Agent is not connected.");return
    }
    for key,p:=range entry.Players {
        if p.Instant && p.Conn==nil && s.now().After(p.JoinDeadline) {
            delete(entry.Players,key)
        }
    }
    slot:=0
    for candidate:=2;candidate<=4;candidate++ {
        occupied:=false
        for _,other:=range entry.Players {
            if other.Approved && other.Slot==candidate {occupied=true;break}
        }
        if !occupied {slot=candidate;break}
    }
    if slot==0 {s.mu.Unlock();writeError(w,409,"All controller slots are occupied.");return}
    if entry.Players==nil {entry.Players=make(map[string]*relayPlayer)}
    entry.Players[id]=&relayPlayer{
        ID:id,TokenHash:sha256.Sum256([]byte(token)),
        Approved:true,Slot:slot,Instant:true,
        JoinDeadline:s.now().Add(15*time.Second),
    }
    s.mu.Unlock()
    writeJSON(w,201,map[string]any{
        "playerId":id,"playerToken":token,"status":"approved","slot":slot,
    })
}
