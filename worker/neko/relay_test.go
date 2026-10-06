package webrtc

import (
    "testing"
    "context"
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "time"
    "github.com/m1k1o/neko/server/pkg/utils"
    "strings"
    pion "github.com/pion/webrtc/v4"
    "github.com/m1k1o/neko/server/pkg/types"
)

func TestRelayRequestLifetimeAndCredentials(t *testing.T) {
    now := int64(1700000000000)
    good := []types.ICEServer{{URLs:[]string{"turn:relay.example:3478?transport=tcp","turns:relay.example:5349?transport=tcp"}, Username:"short-lived", Credential:"test-only"}}
    if err:=validateRelayRequest("runtime-a",now+300000,good,good,now); err!=nil { t.Fatal(err) }
    mixed := append([]types.ICEServer{{URLs:[]string{"stun:relay.example:3478"}}},good...)
    if err:=validateRelayRequest("runtime-a",now+300000,mixed,mixed,now);err!=nil {t.Fatal("Cloudflare mixed ICE rejected",err)}
    for _, expiry := range []int64{now-1,now+60000,now+1800001} {
        if err:=validateRelayRequest("runtime-a",expiry,good,good,now); err==nil {t.Fatal("accepted invalid expiry")}
    }
    if err:=validateRelayRequest("",now+300000,good,good,now);err==nil {t.Fatal("accepted missing runtime fence")}
    bad := [][]types.ICEServer{nil,{{URLs:[]string{"stun:relay.example"},Username:"a",Credential:"b"}},{{URLs:[]string{"https://relay.example"},Username:"a",Credential:"b"}},{{URLs:[]string{"turn:relay.example"}}}}
    for _, servers := range bad {
        if err:=validateRelayRequest("runtime-a",now+300000,servers,good,now);err==nil {t.Fatal("accepted invalid frontend")}
        if err:=validateRelayRequest("runtime-a",now+300000,good,servers,now);err==nil {t.Fatal("accepted invalid backend")}
    }
}

func TestRelayConfigurationDoesNotAliasRequest(t *testing.T) {
    request:=[]types.ICEServer{{URLs:[]string{"turn:relay.example"},Username:"a",Credential:"b"}}
    saved:=cloneRelayServers(request)
    request[0].URLs[0]="turn:changed.example"
    request[0].Credential="changed"
    if saved[0].URLs[0]!="turn:relay.example" || saved[0].Credential!="b" {t.Fatal("request mutation changed active config")}
}

func TestRelayRuntimeIdentityUnique(t *testing.T) {
    first,second:=newRelayRuntime(),newRelayRuntime()
    if len(first)!=32 || len(second)!=32 || first==second {t.Fatal("invalid runtime identity")}
}

// Real Pion negotiation verifies the refresh offer changes ICE credentials
// without replacing the peer connection.
func TestRelayOfferRestartsExistingPeer(t *testing.T) {
    backend,err:=pion.NewPeerConnection(pion.Configuration{})
    if err!=nil {t.Fatal(err)}
    defer backend.Close()
    viewer,err:=pion.NewPeerConnection(pion.Configuration{})
    if err!=nil {t.Fatal(err)}
    defer viewer.Close()
    if _,err:=backend.CreateDataChannel("test",nil);err!=nil {t.Fatal(err)}
    peer:=&WebRTCPeerCtx{connection:backend,iceTrickle:true}
    initial,err:=peer.CreateOffer(false)
    if err!=nil {t.Fatal(err)}
    if err:=viewer.SetRemoteDescription(*initial);err!=nil {t.Fatal(err)}
    answer,err:=viewer.CreateAnswer(nil)
    if err!=nil {t.Fatal(err)}
    if err:=viewer.SetLocalDescription(answer);err!=nil {t.Fatal(err)}
    if err:=backend.SetRemoteDescription(answer);err!=nil {t.Fatal(err)}
    refreshed,err:=relayOffer(peer)
    if err!=nil {t.Fatal(err)}
    ufrag:=func(sdp string)string {
        for _,line:=range strings.Split(sdp,"\n") {if strings.HasPrefix(line,"a=ice-ufrag:"){return strings.TrimSpace(line)}}
        return ""
    }
    if ufrag(initial.SDP)=="" || ufrag(initial.SDP)==ufrag(refreshed.SDP) {t.Fatal("ICE restart did not change credentials")}
    if peer.connection!=backend {t.Fatal("refresh replaced peer connection")}
    if err:=viewer.SetRemoteDescription(*refreshed);err!=nil {t.Fatal(err)}
}

// Capture the real route registrations and execute their attached middleware.
// Embedding Router leaves unrelated methods outside this focused test.
type relayTestRouter struct {
    types.Router
    middleware types.MiddlewareHandler
    get,post types.RouterHandler
    getAuth,postAuth types.MiddlewareHandler
}
func (r *relayTestRouter) With(m types.MiddlewareHandler) types.Router {r.middleware=m;return r}
func (r *relayTestRouter) Get(_ string,h types.RouterHandler){r.get=h;r.getAuth=r.middleware}
func (r *relayTestRouter) Post(_ string,h types.RouterHandler){r.post=h;r.postAuth=r.middleware}

func TestRelayRoutesRequireAdminAndFenceRuntime(t *testing.T) {
    manager:=&WebRTCManagerCtx{relayRuntime:"active-runtime",relayExpires:1700000000000}
    router:=&relayTestRouter{}
    manager.RelayRoute(nil)(router)
    if router.getAuth==nil || router.postAuth==nil {t.Fatal("relay route missing authorization")}
    for _,middleware:=range []types.MiddlewareHandler{router.getAuth,router.postAuth} {
        if _,err:=middleware(httptest.NewRecorder(),httptest.NewRequest("GET","/",nil));err==nil {t.Fatal("unauthenticated relay allowed")}
    }
    input:=map[string]any{"runtimeId":"old-runtime","expiresAt":time.Now().UnixMilli()+300000,
        "frontend":[]types.ICEServer{{URLs:[]string{"turn:relay.example"},Username:"a",Credential:"b"}},
        "backend":[]types.ICEServer{{URLs:[]string{"turn:relay.example"},Username:"a",Credential:"b"}}}
    body,_:=json.Marshal(input)
    req:=httptest.NewRequest("POST","/",bytes.NewReader(body))
    req.Header.Set("Content-Type","application/json")
    err:=router.post(httptest.NewRecorder(),req)
    httpErr,ok:=err.(*utils.HTTPError)
    if !ok || httpErr.Code!=409 {t.Fatalf("runtime fence must return409, got%v",err)}
    if manager.relayExpires!=1700000000000 {t.Fatal("failed refresh changed durable expiry")}
}

// Pion's pinned release has no supported SDP rollback transition. A canceled
// operation must fail before leaving a new local offer in the existing peer.
func TestRelayApplyCancellationPreservesStableSignaling(t *testing.T) {
    connection,err:=pion.NewPeerConnection(pion.Configuration{})
    if err!=nil {t.Fatal(err)}
    defer connection.Close()
    if _,err:=connection.CreateDataChannel("test",nil);err!=nil {t.Fatal(err)}
    offer,err:=connection.CreateOffer(nil)
    if err!=nil {t.Fatal(err)}
    ctx,cancel:=context.WithCancel(context.Background());cancel()
    peer:=&WebRTCPeerCtx{connection:connection,iceTrickle:true}
    if _,err:=applyRelayOffer(ctx,peer,offer,time.Now().Add(time.Second));err==nil {t.Fatal("canceled relay applied")}
    if connection.SignalingState()!=pion.SignalingStateStable {t.Fatal("canceled relay changed signaling")}
}

func TestRelayPhaseOnePreparesEveryOfferWithoutPublishingLocalSDP(t *testing.T) {
    targets:=[]relayTarget{}
    for i:=0;i<2;i++ {
        connection,err:=pion.NewPeerConnection(pion.Configuration{})
        if err!=nil {t.Fatal(err)}
        defer connection.Close()
        if _,err:=connection.CreateDataChannel("test",nil);err!=nil {t.Fatal(err)}
        viewer,err:=pion.NewPeerConnection(pion.Configuration{})
        if err!=nil {t.Fatal(err)}
        defer viewer.Close()
        initial,err:=connection.CreateOffer(nil)
        if err!=nil {t.Fatal(err)}
        if err:=connection.SetLocalDescription(initial);err!=nil {t.Fatal(err)}
        if err:=viewer.SetRemoteDescription(initial);err!=nil {t.Fatal(err)}
        answer,err:=viewer.CreateAnswer(nil)
        if err!=nil {t.Fatal(err)}
        if err:=viewer.SetLocalDescription(answer);err!=nil {t.Fatal(err)}
        if err:=connection.SetRemoteDescription(answer);err!=nil {t.Fatal(err)}
        targets=append(targets,relayTarget{peer:&WebRTCPeerCtx{connection:connection,iceTrickle:true}})
    }
    offers,err:=prepareRelayOffers(context.Background(),targets,pion.Configuration{},pion.Configuration{},time.Now().Add(time.Second))
    if err!=nil {t.Fatal(err)}
    if len(offers)!=2 {t.Fatal("missing prepared viewer offer")}
    for _,target:=range targets {
        if target.peer.connection.SignalingState()!=pion.SignalingStateStable {t.Fatal("preparation published SDP before all peers validated")}
    }
}
