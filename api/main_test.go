package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func apiRequest(h http.Handler, method, path, token string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:30000"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestRoomLifecycle(t *testing.T) {
	s := newServer()
	h := s.routes()
	w := apiRequest(h, "POST", "/api/rooms", "", nil)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created struct{ Code, StreamID, HostToken string }
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !validCode(created.Code) || len(created.StreamID) != 40 || len(created.HostToken) != 64 {
		t.Fatalf("unexpected created room: %+v", created)
	}

	path := fmt.Sprintf("/api/rooms/%s", created.Code)
	w = apiRequest(h, "GET", path, "", nil)
	if w.Code != 200 {
		t.Fatalf("get: %d", w.Code)
	}
	if bytes.Contains(w.Body.Bytes(), []byte(created.HostToken)) {
		t.Fatal("host token leaked to viewer")
	}

	w = apiRequest(h, "PATCH", path, "bad", []byte(`{"live":true}`))
	if w.Code != 404 {
		t.Fatalf("unauthorized update: %d", w.Code)
	}

	w = apiRequest(h, "PATCH", path, created.HostToken, []byte(`{"live":true}`))
	if w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	w = apiRequest(h, "GET", path, "", nil)
	if !bytes.Contains(w.Body.Bytes(), []byte(`"status":"live"`)) {
		t.Fatalf("not live: %s", w.Body.String())
	}

	w = apiRequest(h, "POST", path+"/heartbeat", created.HostToken, nil)
	if w.Code != 200 {
		t.Fatalf("heartbeat: %d", w.Code)
	}
	w = apiRequest(h, "DELETE", path, created.HostToken, nil)
	if w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}
	w = apiRequest(h, "GET", path, "", nil)
	if w.Code != 404 {
		t.Fatalf("deleted room remains visible: %d", w.Code)
	}
}

func TestHeartbeatExpiry(t *testing.T) {
	s := newServer()
	now := time.Now()
	s.now = func() time.Time { return now }
	h := s.routes()
	w := apiRequest(h, "POST", "/api/rooms", "", nil)
	var created struct{ Code, HostToken string }
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	path := "/api/rooms/" + created.Code
	now = now.Add(hostGracePeriod + time.Second)
	w = apiRequest(h, "GET", path, "", nil)
	if w.Code != 404 {
		t.Fatalf("expired host remains: %d", w.Code)
	}
	w = apiRequest(h, "POST", path+"/heartbeat", created.HostToken, nil)
	if w.Code != 404 {
		t.Fatalf("expired host can revive room: %d", w.Code)
	}
}

func TestValidationAndLimits(t *testing.T) {
	s := newServer()
	h := s.routes()
	w := apiRequest(h, "GET", "/api/rooms/abcdef", "", nil)
	if w.Code != 400 {
		t.Fatalf("invalid code status: %d", w.Code)
	}
	for i := 0; i < 30; i++ {
		apiRequest(h, "GET", "/api/rooms/999999", "", nil)
	}
	w = apiRequest(h, "GET", "/api/rooms/999999", "", nil)
	if w.Code != 429 {
		t.Fatalf("limit status: %d", w.Code)
	}
}
