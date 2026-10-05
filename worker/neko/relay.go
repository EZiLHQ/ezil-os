package webrtc

import (
    "crypto/rand"
    "encoding/hex"
    "net/http"
    "os"
    "strconv"
    "time"
    "fmt"
    "strings"
    "context"

    "github.com/m1k1o/neko/server/pkg/auth"
    "github.com/m1k1o/neko/server/pkg/types"
    "github.com/m1k1o/neko/server/pkg/types/event"
    "github.com/m1k1o/neko/server/pkg/types/message"
    "github.com/m1k1o/neko/server/pkg/utils"
    "github.com/pion/webrtc/v4"
)

func newRelayRuntime() string {
    var b [16]byte
    if _, err := rand.Read(b[:]); err != nil { panic("runtime identity unavailable") }
    return hex.EncodeToString(b[:])
}

func initialRelayExpiry() int64 {
    value, _ := strconv.ParseInt(os.Getenv("EZIL_RELAY_EXPIRES_AT"), 10, 64)
    return value
}

func (m *WebRTCManagerCtx) RelayRoute(sessions types.SessionManager) func(types.Router) {
    return func(r types.Router) {
        r.With(auth.AdminsOnly).Get("/", func(w http.ResponseWriter, r *http.Request) error {
            m.relayMu.RLock()
            defer m.relayMu.RUnlock()
            return utils.HttpSuccess(w, map[string]any{"runtimeId":m.relayRuntime, "expiresAt":m.relayExpires})
        })
        r.With(auth.AdminsOnly).Post("/", func(w http.ResponseWriter, r *http.Request) error {
            m.relayOperationMu.Lock()
            defer m.relayOperationMu.Unlock()
            var data struct {
                RuntimeID string `json:"runtimeId"`
                ExpiresAt int64 `json:"expiresAt"`
                Frontend []types.ICEServer `json:"frontend"`
                Backend []types.ICEServer `json:"backend"`
            }
            if err := utils.HttpJsonRequest(w,r,&data); err != nil { return err }
            if err := validateRelayRequest(data.RuntimeID, data.ExpiresAt, data.Frontend, data.Backend, time.Now().UnixMilli()); err != nil {
                return utils.HttpBadRequest("invalid relay refresh")
            }
            m.relayMu.Lock()
            locked := true
            defer func(){ if locked { m.relayMu.Unlock() } }()
            if data.RuntimeID != m.relayRuntime { return utils.HttpError(http.StatusConflict,"relay runtime changed") }
            if data.ExpiresAt <= m.relayExpires { return utils.HttpSuccess(w,map[string]any{"runtimeId":m.relayRuntime,"expiresAt":m.relayExpires}) }
            servers := make([]webrtc.ICEServer,0,len(data.Backend))
            for _, s := range data.Backend {
                servers = append(servers,webrtc.ICEServer{URLs:s.URLs,Username:s.Username,Credential:s.Credential,CredentialType:webrtc.ICECredentialTypePassword})
            }
            configuration := m.webrtcConfiguration
            configuration.ICEServers = servers
            // Capture concrete peers once. Session replacement/disconnect must not
            // switch the target halfway through configuration and negotiation.
            targets := []relayTarget{}
            for _, session := range sessions.List() {
                peer, ok := session.GetWebRTCPeer().(*WebRTCPeerCtx)
                if ok { targets=append(targets,relayTarget{session:session,peer:peer}) }
            }
            deadline:=time.Now().Add(15*time.Second)
            if requestDeadline,ok:=r.Context().Deadline(); ok && requestDeadline.Before(deadline) { deadline=requestDeadline }
            // Phase one creates every restart offer before sending any. Pion
            // restarts ICE in CreateOffer itself and has no usable rollback;
            // failures reconnect affected peers rather than claiming rollback.
            previous:=m.webrtcConfiguration
            offers,err:=prepareRelayOffers(r.Context(),targets,configuration,previous,deadline)
            if err!=nil {
                m.relayMu.Unlock();locked=false
                for _,target:=range targets { reconnectRelayPeer(target) }
                return utils.HttpInternalServerError()
            }
            m.webrtcConfiguration = configuration
            m.config.ICEServersFrontend = cloneRelayServers(data.Frontend)
            m.config.ICEServersBackend = cloneRelayServers(data.Backend)
            // Publish configuration before new connections can be created; the
            // manager mutex must never be held during websocket network writes.
            m.relayMu.Unlock()
            locked=false
            for i,target:=range targets {
                if target.session.GetWebRTCPeer()!=target.peer { continue }
                offer,err:=applyRelayOffer(r.Context(),target.peer,offers[i],deadline)
                if err!=nil {
                    reconnectRelayPeer(target)
                    // Prepared but unsent peers also have restarted ICE. Clear
                    // them so stale local state cannot wedge subsequent retries.
                    for _,remaining:=range targets[i+1:] { reconnectRelayPeer(remaining) }
                    return utils.HttpInternalServerError()
                }
                sender,ok:=target.session.(interface { SendRelay(string,any,time.Time) error })
                sendDeadline:=time.Now().Add(2*time.Second)
                if deadline.Before(sendDeadline) { sendDeadline=deadline }
                if !ok { reconnectRelayPeer(target);return utils.HttpInternalServerError() }
                if err:=sender.SendRelay(event.SIGNAL_OFFER,message.SignalDescription{SDP:offer.SDP,ICEServers:data.Frontend},sendDeadline);err!=nil {
                    reconnectRelayPeer(target)
                    for _,remaining:=range targets[i+1:] {reconnectRelayPeer(remaining)}
                    return utils.HttpInternalServerError()
                }
            }
            m.relayMu.Lock()
            locked=true
            m.relayExpires = data.ExpiresAt
            return utils.HttpSuccess(w,map[string]any{"runtimeId":m.relayRuntime,"expiresAt":m.relayExpires})
        })
    }
}

// Cloudflare includes STUN discovery alongside authenticated TURN relays.
func validateRelayRequest(runtime string, expiry int64, frontend, backend []types.ICEServer, now int64) error {
    if runtime == "" || expiry <= now+60000 || expiry > now+1800000 { return fmt.Errorf("invalid lifetime") }
    for _, servers := range [][]types.ICEServer{frontend, backend} {
        if len(servers)==0 || len(servers)>8 { return fmt.Errorf("invalid server count") }
        hasRelay := false
        for _, server := range servers {
            if len(server.URLs)==0 || len(server.URLs)>8 { return fmt.Errorf("missing ICE endpoints") }
            for _, url := range server.URLs {
                switch {
                case strings.HasPrefix(url,"stun:"):
                case strings.HasPrefix(url,"turn:"), strings.HasPrefix(url,"turns:"):
                    if server.Username=="" || server.Credential=="" { return fmt.Errorf("missing relay credentials") }
                    hasRelay = true
                default: return fmt.Errorf("invalid ICE scheme")
                }
            }
        }
        if !hasRelay { return fmt.Errorf("missing TURN relay") }
    }
    return nil
}

func cloneRelayServers(servers []types.ICEServer) []types.ICEServer {
    out := append([]types.ICEServer(nil), servers...)
    for i := range out { out[i].URLs = append([]string(nil),out[i].URLs...) }
    return out
}

type relayTarget struct { session types.Session; peer *WebRTCPeerCtx }

func reconnectRelayPeer(target relayTarget) {
    // Identity checking in SetWebRTCConnected prevents clearing a replacement.
    target.session.SetWebRTCConnected(target.peer,false)
    target.peer.Destroy()
}

func prepareRelayOffers(ctx context.Context,targets []relayTarget,configuration,previous webrtc.Configuration,deadline time.Time) ([]webrtc.SessionDescription,error) {
    offers:=make([]webrtc.SessionDescription,0,len(targets))
    changed:=[]relayTarget{}
    fail:=func(err error)([]webrtc.SessionDescription,error){
        for _,target:=range changed {
            target.peer.mu.Lock()
            _=target.peer.connection.SetConfiguration(previous)
            target.peer.mu.Unlock()
        }
        return nil,err
    }
    for _,target:=range targets {
        target.peer.mu.Lock()
        stable:=target.peer.connection.SignalingState()==webrtc.SignalingStateStable
        target.peer.mu.Unlock()
        if !stable { return nil,fmt.Errorf("relay negotiation busy") }
    }
    for _,target:=range targets {
        if ctx.Err()!=nil || time.Now().After(deadline) { return fail(fmt.Errorf("relay preparation timed out")) }
        target.peer.mu.Lock()
        if target.peer.connection.SignalingState()!=webrtc.SignalingStateStable {
            target.peer.mu.Unlock()
            return fail(fmt.Errorf("relay negotiation busy"))
        }
        err:=target.peer.connection.SetConfiguration(configuration)
        if err!=nil { target.peer.mu.Unlock();return fail(err) }
        changed=append(changed,target)
        offer,err:=target.peer.connection.CreateOffer(&webrtc.OfferOptions{ICERestart:true})
        target.peer.mu.Unlock()
        if err!=nil {return fail(err)}
        offers=append(offers,offer)
    }
    return offers,nil
}

func applyRelayOffer(ctx context.Context,peer *WebRTCPeerCtx,offer webrtc.SessionDescription,deadline time.Time)(*webrtc.SessionDescription,error){
    peer.mu.Lock()
    defer peer.mu.Unlock()
    if ctx.Err()!=nil || time.Now().After(deadline) { return nil,fmt.Errorf("relay deadline exceeded") }
    if peer.connection.SignalingState()!=webrtc.SignalingStateStable { return nil,fmt.Errorf("relay negotiation busy") }
    gather:=webrtc.GatheringCompletePromise(peer.connection)
    if err:=peer.connection.SetLocalDescription(offer);err!=nil{return nil,err}
    if !peer.iceTrickle {
        timer:=time.NewTimer(time.Until(deadline));defer timer.Stop()
        select {case <-gather: case <-ctx.Done():return nil,ctx.Err();case <-timer.C:return nil,fmt.Errorf("relay gathering timed out")}
    }
    return peer.connection.LocalDescription(),nil
}

func relayOffer(candidate types.WebRTCPeer)(*webrtc.SessionDescription,error){
    peer,ok:=candidate.(*WebRTCPeerCtx);if !ok{return nil,fmt.Errorf("unsupported relay peer")}
    peer.mu.Lock()
    offer,err:=peer.connection.CreateOffer(&webrtc.OfferOptions{ICERestart:true})
    peer.mu.Unlock()
    if err!=nil{return nil,err}
    return applyRelayOffer(context.Background(),peer,offer,time.Now().Add(15*time.Second))
}
