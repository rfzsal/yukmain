package main

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/gorilla/websocket"
    "strings"
)

func TestAgentPairingAndSocket(t *testing.T) {
    t.Setenv("YUKMAIN_RELAY_DEBUG", "0")
    s:=newServer()
    h:=s.routes()
    w:=apiRequest(h,"POST","/api/rooms","",nil)
    if w.Code!=201 {t.Fatalf("create %d",w.Code)}
    var room struct{Code,HostToken string}
    if err:=json.Unmarshal(w.Body.Bytes(),&room);err!=nil {t.Fatal(err)}
    path:="/api/rooms/"+room.Code+"/pairing"

    w=apiRequest(h,"POST",path,"wrong",nil)
    if w.Code!=404 {t.Fatalf("unauthorized pairing: %d",w.Code)}

    w=apiRequest(h,"POST",path,room.HostToken,nil)
    if w.Code!=200 {t.Fatalf("create pairing: %d %s",w.Code,w.Body.String())}
    var issued struct{PairingCode string}
    if err:=json.Unmarshal(w.Body.Bytes(),&issued);err!=nil {t.Fatal(err)}
    if len(issued.PairingCode)!=8 {t.Fatal("invalid pairing code")}

    redeem:=func(code string)*httptest.ResponseRecorder {
        payload,_:=json.Marshal(map[string]string{"pairingCode":code})
        return apiRequest(h,"POST",path+"/redeem","",payload)
    }
    if w=redeem("11111111");w.Code!=401 {t.Fatalf("bad pairing accepted: %d",w.Code)}
    w=redeem(issued.PairingCode)
    if w.Code!=200 {t.Fatalf("redeem: %d %s",w.Code,w.Body.String())}
    var paired struct{AgentToken string}
    if err:=json.Unmarshal(w.Body.Bytes(),&paired);err!=nil {t.Fatal(err)}
    if len(paired.AgentToken)!=64 {t.Fatal("missing agent credential")}
    if w=redeem(issued.PairingCode);w.Code!=401 {t.Fatalf("replayed code: %d",w.Code)}

    w=apiRequest(h,"GET",path,room.HostToken,nil)
    if w.Code!=200 || !bytes.Contains(w.Body.Bytes(),[]byte(`"paired":true`)) {t.Fatalf("status: %d %s",w.Code,w.Body.String())}

    httpServer:=httptest.NewServer(h)
    defer httpServer.Close()
    address:="ws"+strings.TrimPrefix(httpServer.URL,"http")+"/api/rooms/"+room.Code+"/relay?role=agent"
    dialer:=websocket.Dialer{Subprotocols:[]string{"yukmain.v1","yukmain-agent."+paired.AgentToken}}
    conn,response,err:=dialer.Dial(address,nil)
    if err!=nil {
        if response!=nil {t.Fatalf("agent ws: %d %v",response.StatusCode,err)}
        t.Fatal(err)
    }
    defer conn.Close()
    _=conn.SetReadDeadline(time.Now().Add(2*time.Second))
    var event struct{Type,Role string}
    if err:=conn.ReadJSON(&event);err!=nil {t.Fatal(err)}
    if event.Type!="connection.ready" || event.Role!="agent" {t.Fatalf("unexpected agent event %+v",event)}

    // Re-pairing replaces the credential and closes the old connection.
    w=apiRequest(h,"POST",path,room.HostToken,nil)
    if w.Code!=200 {t.Fatalf("rotate pairing: %d",w.Code)}
    _=conn.SetReadDeadline(time.Now().Add(2*time.Second))
    if err:=conn.ReadJSON(&event);err==nil {t.Fatal("old agent remained connected after re-pairing")}
}

func TestAgentPairingExpires(t *testing.T) {
    s:=newServer()
    current:=time.Now()
    s.now=func()time.Time{return current}
    h:=s.routes()
    w:=apiRequest(h,"POST","/api/rooms","",nil)
    var room struct{Code,HostToken string}
    if err:=json.Unmarshal(w.Body.Bytes(),&room);err!=nil {t.Fatal(err)}
    path:="/api/rooms/"+room.Code+"/pairing"
    w=apiRequest(h,"POST",path,room.HostToken,nil)
    var issued struct{PairingCode string}
    if err:=json.Unmarshal(w.Body.Bytes(),&issued);err!=nil {t.Fatal(err)}
    current=current.Add(4*time.Minute)
    body,_:=json.Marshal(map[string]string{"pairingCode":issued.PairingCode})
    w=apiRequest(h,"POST",path+"/redeem","",body)
    if w.Code!=401 {t.Fatalf("expired pairing accepted: %d",w.Code)}
}
