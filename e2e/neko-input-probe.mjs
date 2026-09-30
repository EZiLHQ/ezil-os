// These functions run inside the Neko iframe via Playwright's evaluate().
// Successful send() calls establish local transport acceptance, not remote
// textbox contents or physical-phone keyboard behavior.
export function nekoInputState() {
    const client = window.$client;
    const remote = client?.$accessor?.remote;
    const state = {
        overlay: Boolean(document.querySelector('textarea.overlay')),
        socketOpen: client?.socketOpen === true,
        ice: client?._peer?.iceConnectionState ?? 'absent',
        channel: client?._channel?.readyState ?? 'absent',
        hosting: remote?.hosting === true,
        unlocked: remote?.locked === false,
    };
    return {
        ...state,
        ready: state.overlay && state.socketOpen && state.channel === 'open'
            && ['connected', 'completed'].includes(state.ice)
            && state.hosting && state.unlocked,
    };
}

export async function probeComposedWord() {
    const client = window.$client;
    const channel = client?._channel;
    const remote = client?.$accessor?.remote;
    const textarea = document.querySelector('textarea.overlay');
    const result = { frames: [], sendErrors: 0, pageErrors: 0, malformed: 0, overflow: false };
    // Recheck after the caller's readiness wait: reconnects can race it.
    if (!textarea || !client?.socketOpen || channel?.readyState !== 'open'
        || !['connected', 'completed'].includes(client?._peer?.iceConnectionState)
        || remote?.hosting !== true || remote?.locked !== false) {
        return { ...result, error: 'input_not_ready' };
    }
    const prototype = RTCDataChannel.prototype;
    const original = prototype.send;
    const onError = () => { result.pageErrors++; };
    window.addEventListener('error', onError);
    prototype.send = function (data) {
        if (this !== channel) return original.apply(this, arguments);
        let sent;
        try {
            sent = original.apply(this, arguments);
        } catch (error) {
            result.sendErrors++;
            throw error;
        }
        // Count only calls accepted by the real channel, and decode the
        // complete Neko key packet instead of trusting its first byte.
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
            : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (!bytes || ![3, 4].includes(bytes[0])) return sent;
        if (bytes.length !== 11 || bytes[1] !== 8 || bytes[2] !== 0) {
            result.malformed++;
        } else if (result.frames.length >= 32) {
            result.overflow = true;
        } else {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            result.frames.push([bytes[0], view.getBigUint64(3, true).toString()]);
        }
        return sent;
    };
    try {
        textarea.focus();
        const dispatch = (Class, type, data) => textarea.dispatchEvent(new Class(type, { bubbles: true, ...data }));
        dispatch(CompositionEvent, 'compositionstart', { data: '' });
        for (const char of 'fast') {
            const code = char.toUpperCase().charCodeAt(0);
            dispatch(KeyboardEvent, 'keydown', { key: char, keyCode: code, which: code });
            textarea.value += char;
            dispatch(InputEvent, 'input', { data: char, inputType: 'insertCompositionText', isComposing: true });
            dispatch(KeyboardEvent, 'keyup', { key: char, keyCode: code, which: code });
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        dispatch(CompositionEvent, 'compositionend', { data: 'fast' });
        await new Promise(resolve => setTimeout(resolve, 500));
        return { ...result, channelAfter: channel.readyState, sameChannel: client._channel === channel };
    } finally {
        prototype.send = original;
        window.removeEventListener('error', onError);
    }
}

export function composedWordPassed(result) {
    const expected = [...'fast'].flatMap(char => [[3, String(char.codePointAt(0))], [4, String(char.codePointAt(0))]]);
    return !result.error && result.sendErrors === 0 && result.pageErrors === 0
        && result.malformed === 0 && result.overflow === false
        && result.channelAfter === 'open' && result.sameChannel === true
        && JSON.stringify(result.frames) === JSON.stringify(expected);
}
