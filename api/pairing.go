package main

import (
    "crypto/sha256"
    "crypto/subtle"
    "encoding/json"
    "net/http"
    "time"
)

// An agent pairing is initiated by the authenticated room owner. The short
// one-time code is entered locally on the PC, never embedded in an invite URL.
const pairingLifetime = 3 * time.Minute

func (s *server) initiatePairing(w http.ResponseWriter, r *http.Request) {
    s.mu.Lock()
    defer s.mu.Unlock()
    entry, ok := s.authorizedRoom(r)
    if !ok { writeError(w, 404, "Room unavailable or access denied."); return }
    code,err := secureHex(4)
    if err!=nil { writeError(w, 500, "Unable to create pairing code."); return }
    entry.PairingHash = sha256.Sum256([]byte(code))
    entry.PairingExpires = s.now().Add(pairingLifetime)
    // A new code revokes previously issued credentials and closes existing
    // agent connections. Browser debugging is a separate, mutually exclusive receiver.
    entry.AgentTokenHash = [32]byte{}
    if entry.HostWS!=nil && entry.HostKind=="agent" {
        entry.HostWS.close()
        entry.HostWS=nil
        entry.HostKind=""
    }
    writeJSON(w, 200, map[string]any{
        "pairingCode":code, "expiresAt":entry.PairingExpires,
    })
}

func (s *server) redeemPairing(w http.ResponseWriter, r *http.Request) {
    if !s.allow(r,"pairing-redeem",8,10*time.Minute) {
        writeError(w, 429, "Too many pairing attempts."); return
    }
    r.Body=http.MaxBytesReader(w,r.Body,1024)
    var payload struct{ PairingCode string `json:"pairingCode"` }
    if json.NewDecoder(r.Body).Decode(&payload)!=nil || len(payload.PairingCode)!=8 {
        writeError(w, 400, "Invalid pairing request."); return
    }
    provided:=sha256.Sum256([]byte(payload.PairingCode))
    s.mu.Lock()
    entry, ok:=s.rooms[r.PathValue("code")]
    if !ok || !s.isAvailable(entry,s.now()) ||
       entry.PairingExpires.IsZero() || !s.now().Before(entry.PairingExpires) ||
       subtle.ConstantTimeCompare(provided[:],entry.PairingHash[:])!=1 {
        s.mu.Unlock()
        writeError(w, 401, "Pairing code invalid or expired."); return
    }
    // Burn the code before allocating the token.
    entry.PairingExpires=time.Time{}
    entry.PairingHash=[32]byte{}
    token,err:=secureHex(32)
    if err!=nil { s.mu.Unlock(); writeError(w,500,"Pairing failed."); return }
    entry.AgentTokenHash=sha256.Sum256([]byte(token))
    s.mu.Unlock()
    writeJSON(w, 200, map[string]any{"agentToken":token, "roomCode":r.PathValue("code")})
}

func (s *server) pairingStatus(w http.ResponseWriter, r *http.Request) {
    s.mu.Lock()
    entry,ok:=s.authorizedRoom(r)
    if !ok { s.mu.Unlock(); writeError(w,404,"Room unavailable or access denied."); return }
    connected:=entry.HostWS!=nil && entry.HostKind=="agent"
    paired:=entry.AgentTokenHash!=[32]byte{}
    s.mu.Unlock()
    writeJSON(w,200,map[string]bool{"paired":paired,"agentConnected":connected})
}
