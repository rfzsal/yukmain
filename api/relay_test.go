package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
    "time"

    "github.com/gorilla/websocket"
)

type relayFixture struct {
    server *server
    handler http.Handler
    code string
    hostToken string
}

func newRelayFixture(t *testing.T) relayFixture {
    t.Helper()
    t.Setenv("YUKMAIN_RELAY_DEBUG", "1")
    s:=newServer()
    handler:=s.routes()
    response:=apiRequest(handler,"POST","/api/rooms","",nil)
    if response.Code!=201 { t.Fatalf("create room: %d %s",response.Code,response.Body.String()) }
    var room struct{ Code, HostToken string }
    if err:=json.Unmarshal(response.Body.Bytes(),&room); err!=nil {t.Fatal(err)}
    return relayFixture{s,handler,room.Code,room.HostToken}
}

func (f relayFixture) guest(t *testing.T) (string,string) {
    t.Helper()
    w:=apiRequest(f.handler,"POST","/api/rooms/"+f.code+"/players","",nil)
    if w.Code!=201 {t.Fatalf("register: %d %s",w.Code,w.Body.String())}
    var p struct{PlayerID,PlayerToken string}
    if err:=json.Unmarshal(w.Body.Bytes(),&p); err!=nil {t.Fatal(err)}
    return p.PlayerID,p.PlayerToken
}

func (f relayFixture) decide(t *testing.T,id string, approved bool,slot int) int {
    t.Helper()
    body,_:=json.Marshal(map[string]any{"approved":approved,"slot":slot})
    w:=apiRequest(f.handler,"PATCH",fmt.Sprintf("/api/rooms/%s/players/%s",f.code,id),f.hostToken,body)
    return w.Code
}

func openSocket(t *testing.T, baseURL, code, role, token, playerID string) *websocket.Conn {
    t.Helper()
    u:="ws"+strings.TrimPrefix(baseURL,"http")+"/api/rooms/"+code+"/relay?role="+role
    if playerID!="" { u+="&playerId="+playerID }
    dialer:=websocket.Dialer{Subprotocols:[]string{"yukmain.v1","yukmain-"+role+"."+token}}
    conn,response,err:=dialer.Dial(u,nil)
    if err!=nil {
        status:=0
        if response!=nil {status=response.StatusCode}
        t.Fatalf("connect %s failed: http %d: %v",role,status,err)
    }
    t.Cleanup(func(){_ = conn.Close()})
    return conn
}

func readEvent(t *testing.T,conn *websocket.Conn,want string) map[string]any {
    t.Helper()
    _=conn.SetReadDeadline(time.Now().Add(3*time.Second))
    for i:=0;i<12;i++ {
        var event map[string]any
        if err:=conn.ReadJSON(&event);err!=nil {t.Fatalf("read %s: %v",want,err)}
        if event["type"]==want {return event}
    }
    t.Fatalf("event %s not received",want)
    return nil
}

func TestRelayDisabledByDefault(t *testing.T) {
    t.Setenv("YUKMAIN_RELAY_DEBUG","0")
    s:=newServer()
    w:=apiRequest(s.routes(),"GET","/api/relay/config","",nil)
    if w.Code!=404 {t.Fatalf("debug UI must be disabled by default, got %d",w.Code)}
}

func TestRelayAuthorizationAndDelivery(t *testing.T) {
    fixture:=newRelayFixture(t)
    server:=httptest.NewServer(fixture.handler)
    defer server.Close()

    // An invalid credential must not create a host receiver.
    u:="ws"+strings.TrimPrefix(server.URL,"http")+"/api/rooms/"+fixture.code+"/relay?role=host"
    badDialer:=websocket.Dialer{Subprotocols:[]string{"yukmain.v1","yukmain-host."+strings.Repeat("a",64)}}
    invalid,response,err:=badDialer.Dial(u,nil)
    if err==nil { _=invalid.Close();t.Fatal("invalid host authenticated") }
    if response==nil || response.StatusCode!=401 {t.Fatalf("expected 401, got %v",response)}

    host:=openSocket(t,server.URL,fixture.code,"host",fixture.hostToken,"")
    readEvent(t,host,"connection.ready")

    id,token:=fixture.guest(t)
    player:=openSocket(t,server.URL,fixture.code,"player",token,id)
    readEvent(t,player,"connection.ready")
    status:=readEvent(t,player,"player.status")
    if status["status"]!="pending" {t.Fatal("new guests must be pending")}

    validState:=map[string]any{
        "type":"controller.state","seq":1,"buttons":[]string{"A"},"dpad":"none",
        "leftStick":map[string]float64{"x":0,"y":0},
        "rightStick":map[string]float64{"x":0,"y":0},
        "leftTrigger":0,"rightTrigger":0,
    }
    if err:=player.WriteJSON(validState); err!=nil {t.Fatal(err)}
    readEvent(t,player,"input.rejected")

    if code:=fixture.decide(t,id,true,2);code!=200 {t.Fatalf("approve: %d",code)}
    status=readEvent(t,player,"player.status")
    if status["status"]!="approved" || status["slot"]!=float64(2) {
        t.Fatalf("player status: %+v",status)
    }

    if err:=player.WriteJSON(validState); err!=nil {t.Fatal(err)}
    received:=readEvent(t,host,"controller.state")
    if received["slot"]!=float64(2) || received["playerId"]!=id || received["seq"]!=float64(1) {
        t.Fatalf("incorrect recipient or slot: %+v",received)
    }
    buttons,ok:=received["buttons"].([]any)
    if !ok || len(buttons)!=1 || buttons[0]!="A" {
        t.Fatalf("incorrect controller payload: %+v",received)
    }

    // Replay attempts are rejected and never reach the host.
    if err:=player.WriteJSON(validState); err!=nil {t.Fatal(err)}
    readEvent(t,player,"input.rejected")

    secondID,_:=fixture.guest(t)
    if code:=fixture.decide(t,secondID,true,2);code!=409 {
        t.Fatalf("occupied P2 slot must return 409, got %d",code)
    }
    if code:=fixture.decide(t,id,false,0);code!=200 {t.Fatalf("reject: %d",code)}
    readEvent(t,host,"controller.neutral")
    if err:=player.WriteJSON(map[string]any{
        "type":"controller.state","seq":2,"buttons":[]string{},"dpad":"none",
    });err!=nil {t.Fatal(err)}
    readEvent(t,player,"input.rejected")
}

func TestRelayRoomCloseDisconnectsSockets(t *testing.T) {
    fixture:=newRelayFixture(t)
    server:=httptest.NewServer(fixture.handler)
    defer server.Close()
    host:=openSocket(t,server.URL,fixture.code,"host",fixture.hostToken,"")
    readEvent(t,host,"connection.ready")
    w:=apiRequest(fixture.handler,"DELETE","/api/rooms/"+fixture.code,fixture.hostToken,nil)
    if w.Code!=204 {t.Fatalf("close room: %d",w.Code)}
    _=host.SetReadDeadline(time.Now().Add(2*time.Second))
    var packet any
    if err:=host.ReadJSON(&packet);err==nil {
        t.Fatal("room close should disconnect host")
    }
}

func TestRelayInvalidApproval(t *testing.T) {
    fixture:=newRelayFixture(t)
    id,_:=fixture.guest(t)
    b:=[]byte(`{"approved":true,"slot":8}`)
    path:=fmt.Sprintf("/api/rooms/%s/players/%s",fixture.code,id)
    w:=apiRequest(fixture.handler,"PATCH",path,fixture.hostToken,b)
    if w.Code!=400 {t.Fatalf("invalid slot accepted: %d",w.Code)}
    w=apiRequest(fixture.handler,"PATCH",path,"invalid",bytes.TrimSpace([]byte(`{"approved":true,"slot":2}`)))
    if w.Code!=404 {t.Fatalf("invalid host authorization accepted: %d",w.Code)}
}
