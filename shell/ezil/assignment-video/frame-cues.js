// Only the two first-party app adapters register a verified frame. This module sends an on/off
// lease to the exact origin and document binding. It accepts no input or messages from the frame.
let activeComputer = null;
const frameBindings = new Map();
let heartbeat;

export function bindFrameClickCues(iframe, origin, binding, computerId) {
    if (location.origin !== 'https://os-staging.ezil.work' || window !== window.top || !binding || !computerId) return () => {};
    const previous = frameBindings.get(iframe);
    if (previous?.binding === binding && previous.origin === origin && previous.computerId === computerId) return previous.detach;
    previous?.detach();
    function send(on) {
        if (!iframe.isConnected || !iframe.contentWindow) return;
        try { iframe.contentWindow.postMessage({type:'ezil.assignment.click-cues',v:1,binding,active:on}, origin); }
        catch { /* The trusted app document has already navigated. Its local lease expires. */ }
    }
    function detach() {
        if (frameBindings.get(iframe)?.detach !== detach) return;
        if (activeComputer === computerId) send(false);
        frameBindings.delete(iframe);
    }
    frameBindings.set(iframe,{origin,binding,computerId,send,detach});
    if (activeComputer === computerId) send(true);
    return detach;
}

export function setFrameClickCues(computerId) {
    if (activeComputer === computerId) return;
    activeComputer = computerId;
    clearInterval(heartbeat);
    const send = () => {
        for (const [iframe,bound] of frameBindings) {
            if (!iframe.isConnected) bound.detach();
            else bound.send(Boolean(activeComputer && activeComputer === bound.computerId));
        }
    };
    send();
    if (activeComputer) heartbeat = setInterval(send,1500);
}
