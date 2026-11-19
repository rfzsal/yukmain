package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	roomLifetime    = 4 * time.Hour
	hostGracePeriod = 90 * time.Second
)

type room struct {
	Code          string
	StreamID      string
	HostTokenHash [32]byte
	CreatedAt     time.Time
	ExpiresAt     time.Time
	LastSeen      time.Time
	Live          bool
	Players map[string]*relayPlayer
	HostWS *relayConn
    HostKind string
    PairingHash [32]byte
    PairingExpires time.Time
    AgentTokenHash [32]byte
    InstantJoinEnabled bool
}

type rateEntry struct {
	Count int
	Reset time.Time
}

type server struct {
	mu    sync.RWMutex
	rooms map[string]*room
	rates map[string]rateEntry
	now   func() time.Time
}

func newServer() *server {
	return &server{
		rooms: make(map[string]*room),
		rates: make(map[string]rateEntry),
		now:   time.Now,
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	s := newServer()
	go s.reaper()

	log.Printf("YukMain API listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, s.routes()))
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.HandleFunc("GET /api/rooms/{code}", s.getRoom)
	mux.HandleFunc("PATCH /api/rooms/{code}", s.setRoomStatus)
	mux.HandleFunc("POST /api/rooms/{code}/heartbeat", s.heartbeat)
	mux.HandleFunc("DELETE /api/rooms/{code}", s.deleteRoom)
    mux.HandleFunc("POST /api/rooms/{code}/pairing", s.initiatePairing)
    mux.HandleFunc("POST /api/rooms/{code}/pairing/redeem", s.redeemPairing)
    mux.HandleFunc("GET /api/rooms/{code}/pairing", s.pairingStatus)
    mux.HandleFunc("GET /api/rooms/{code}/relay", s.relaySocket)
    mux.HandleFunc("POST /api/rooms/{code}/players", s.registerPlayer)
    mux.HandleFunc("POST /api/rooms/{code}/players/instant", s.instantJoin)
    mux.HandleFunc("GET /api/rooms/{code}/controls", s.instantJoinSettings)
    mux.HandleFunc("PATCH /api/rooms/{code}/controls", s.setInstantJoin)
    mux.HandleFunc("GET /api/rooms/{code}/players", s.listPlayers)
    mux.HandleFunc("PATCH /api/rooms/{code}/players/{id}", s.approvePlayer)
    // The browser debug panel is opt-in; authenticated relay and pairing work without it.
    if os.Getenv("YUKMAIN_RELAY_DEBUG") == "1" {
        mux.HandleFunc("GET /api/relay/config", func(w http.ResponseWriter, _ *http.Request) {
            writeJSON(w, 200, map[string]bool{"enabled": true})
        })
    }

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		mux.ServeHTTP(w, r)
	})
}

func (s *server) createRoom(w http.ResponseWriter, r *http.Request) {
	if !s.allow(r, "create", 12, 10*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "Terlalu banyak room baru. Coba lagi nanti.")
		return
	}

	now := s.now()
	streamID, err := secureHex(20)
	if err != nil {
		writeError(w, 500, "Gagal membuat room.")
		return
	}
	hostToken, err := secureHex(32)
	if err != nil {
		writeError(w, 500, "Gagal membuat room.")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < 30; i++ {
		var random [4]byte
		if _, err := rand.Read(random[:]); err != nil {
			break
		}
		value := uint32(random[0])<<24 | uint32(random[1])<<16 | uint32(random[2])<<8 | uint32(random[3])
		code := fmt.Sprintf("%06d", value%1_000_000)
		if existing, ok := s.rooms[code]; ok && s.isAvailable(existing, now) {
			continue
		}
		s.rooms[code] = &room{
			Code: code, StreamID: streamID, HostTokenHash: sha256.Sum256([]byte(hostToken)),
			CreatedAt: now, ExpiresAt: now.Add(roomLifetime), LastSeen: now,
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"code": code, "streamId": streamID, "hostToken": hostToken,
			"status": "preparing", "expiresAt": now.Add(roomLifetime),
		})
		return
	}
	writeError(w, 503, "Tidak dapat membuat room baru. Coba lagi.")
}

func (s *server) getRoom(w http.ResponseWriter, r *http.Request) {
	if !s.allow(r, "join", 30, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "Terlalu banyak percobaan kode. Coba lagi nanti.")
		return
	}
	code := r.PathValue("code")
	if !validCode(code) {
		writeError(w, 400, "Kode harus 6 digit angka.")
		return
	}

	s.mu.RLock()
	entry, ok := s.rooms[code]
	if !ok || !s.isAvailable(entry, s.now()) {
		s.mu.RUnlock()
		writeError(w, 404, "Room tidak ditemukan atau sudah berakhir.")
		return
	}
	status := "preparing"
	if entry.Live {
		status = "live"
	}
	data := map[string]any{"code": entry.Code, "streamId": entry.StreamID, "status": status, "expiresAt": entry.ExpiresAt}
	s.mu.RUnlock()
	writeJSON(w, 200, data)
}

func (s *server) setRoomStatus(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Live *bool `json:"live"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Live == nil {
		writeError(w, 400, "Status tidak valid.")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.authorizedRoom(r)
	if !ok {
		writeError(w, 404, "Room tidak ditemukan atau akses ditolak.")
		return
	}
	entry.Live = *payload.Live
	entry.LastSeen = s.now()
	writeJSON(w, 200, map[string]any{"status": roomStatus(entry)})
}

func (s *server) heartbeat(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.authorizedRoom(r)
	if !ok {
		writeError(w, 404, "Room tidak ditemukan atau akses ditolak.")
		return
	}
	entry.LastSeen = s.now()
	writeJSON(w, 200, map[string]any{"status": roomStatus(entry)})
}

func (s *server) deleteRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.authorizedRoom(r)
	if !ok {
		writeError(w, 404, "Room tidak ditemukan atau akses ditolak.")
		return
	}
	s.closeRelay(entry)
	delete(s.rooms, entry.Code)
	w.WriteHeader(http.StatusNoContent)
}

// authorizedRoom must only be called with s.mu held.
func (s *server) authorizedRoom(r *http.Request) (*room, bool) {
	code := r.PathValue("code")
	if !validCode(code) {
		return nil, false
	}
	entry, ok := s.rooms[code]
	if !ok || !s.isAvailable(entry, s.now()) {
		return nil, false
	}
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(provided) != 64 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return nil, false
	}
	hash := sha256.Sum256([]byte(provided))
	if subtle.ConstantTimeCompare(hash[:], entry.HostTokenHash[:]) != 1 {
		return nil, false
	}
	return entry, true
}

func roomStatus(r *room) string {
	if r.Live {
		return "live"
	}
	return "preparing"
}

func (s *server) isAvailable(r *room, now time.Time) bool {
	return now.Before(r.ExpiresAt) && now.Sub(r.LastSeen) < hostGracePeriod
}

func validCode(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func secureHex(bytes int) (string, error) {
	if bytes <= 0 {
		return "", errors.New("invalid token size")
	}
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// Nginx sets X-Real-IP and the API port is not exposed by Compose.
func clientIP(r *http.Request) string {
	if candidate := r.Header.Get("X-Real-IP"); net.ParseIP(candidate) != nil {
		return candidate
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func (s *server) allow(r *http.Request, action string, limit int, interval time.Duration) bool {
	key := action + ":" + clientIP(r)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, exists := s.rates[key]
	if !exists || !now.Before(entry.Reset) {
		s.rates[key] = rateEntry{Count: 1, Reset: now.Add(interval)}
		return true
	}
	if entry.Count >= limit {
		return false
	}
	entry.Count++
	s.rates[key] = entry
	return true
}

func (s *server) reaper() {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for range tick.C {
		s.mu.Lock()
		now := s.now()
		for code, r := range s.rooms {
			if !s.isAvailable(r, now) {
                s.closeRelay(r)
				delete(s.rooms, code)
			}
		}
		for key, rate := range s.rates {
			if !now.Before(rate.Reset) {
				delete(s.rates, key)
			}
		}
		s.mu.Unlock()
	}
}

func writeError(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}
