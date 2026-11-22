// The browser owns the selection. A distinct, random handle binds it to this particular document.
export const STAGING_OS = 'https://os-staging.ezil.work';
const options = {
    audio: false,
    video: {displaySurface: 'browser', cursor: 'always', frameRate: {ideal: 1, max: 1}},
    preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'exclude', systemAudio: 'exclude',
};

export function identifiesThisTab(stream, origin, handle) {
    const [track, extra] = stream.getVideoTracks();
    if (!track || extra || stream.getAudioTracks().length || track.readyState !== 'live'
        || track.getSettings().displaySurface !== 'browser') return false;
    const identity = track.getCaptureHandle?.();
    return Boolean(identity && identity.origin === origin && identity.handle === handle);
}

export function currentTabPicker(win) {
    const devices = win.navigator.mediaDevices;
    if (win !== win.top || win.location.origin !== STAGING_OS || !win.isSecureContext
        || !devices?.getDisplayMedia || !devices.setCaptureHandleConfig || !win.VideoEncoder
        || !win.MediaStreamTrack?.prototype.getCaptureHandle || !win.VideoFrame)
        throw new Error('unsupported');
    const handle = win.crypto.randomUUID();
    devices.setCaptureHandleConfig({exposeOrigin:true, handle, permittedOrigins:[STAGING_OS]});
    let closed = false;
    function dispose() {
        if (closed) return;
        closed = true;
        devices.setCaptureHandleConfig({exposeOrigin:false, handle:'', permittedOrigins:[]});
    }
    // Call without an intervening await from the participant's trusted button click.
    async function choose() {
        if (closed) throw new Error('closed');
        const stream = await devices.getDisplayMedia(options);
        if (closed || !identifiesThisTab(stream, STAGING_OS, handle)) {
            stream.getTracks().forEach(track => track.stop());
            throw new Error('wrong_tab');
        }
        return {stream, matches: () => !closed && identifiesThisTab(stream, STAGING_OS, handle)};
    }
    return {choose, dispose};
}
