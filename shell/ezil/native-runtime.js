// The preload owns authentication. No token is ever part of the shell payload,
// localStorage, a URL, or a renderer-visible HTTP header.
export function isNative (ctx) {
    const state = ctx?.desktopState ?? ctx?.payload?.desktopState ?? window.__EZIL_BOOT__?.desktopState;
    return state?.provider === 'native-macos' && state?.runtime?.contractVersion === 1;
}

export async function nativeOperation (operation) {
    if ( typeof window.ezilNative?.operation !== 'function' ) return { ok: false, error: 'native_unavailable' };
    let timer;
    try {
        return await Promise.race([
            window.ezilNative.operation(operation),
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'native_unavailable' }), 10_000); }),
        ]);
    } catch { return { ok: false, error: 'native_unavailable' }; }
    finally { clearTimeout(timer); }
}
