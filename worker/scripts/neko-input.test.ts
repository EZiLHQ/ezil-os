import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const launch = readFileSync(new URL('./start-neko.sh', import.meta.url), 'utf8');
const script = readFileSync(new URL('./neko-client.js', import.meta.url), 'utf8');

describe('desktop image input configuration', () => {
    it('installs fonts for CJK, Indic, Arabic/Hebrew, Thai and emoji and caches them', () => {
        for (const pkg of ['fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji', 'fontconfig']) {
            expect(dockerfile).toMatch(new RegExp(`^\\s+${pkg} \\\\`, 'm'));
        }
        expect(dockerfile).toContain('&& fc-cache -f');
    });
    it('uses XKB keysyms and only client repeat with implicit control', () => {
        expect(dockerfile).toContain('x11-xkb-utils');
        expect(dockerfile).toContain('x11-xserver-utils');
        expect(launch).toContain('-layout "${NEKO_XKB_LAYOUT:-us}"');
        expect(launch).toContain('-variant "${NEKO_XKB_VARIANT:-}" -option');
        expect(launch).toContain('r rate 500 25');
        expect(launch).toContain('r off');
        expect(launch).toContain('--session.implicit_hosting=true');
        expect(launch).toContain('--desktop.input.enabled=false');
    });
    it('relies on the pinned client clipboard path (no v3 server flag) and loads the client helper', () => {
        // The pinned legacy-protocol Neko has no server clipboard flag; a v3 flag here broke the image build.
        expect(launch).not.toContain('NEKO_DESKTOP_CLIPBOARD_ENABLED');
        expect(dockerfile).not.toContain('--desktop.clipboard.enabled');
        expect(dockerfile).toContain("grep -rl 'clipboard_read_available' /var/www/js");
        expect(dockerfile).toContain("grep -rl 'clipboard.readText' /var/www/js");
        expect(dockerfile).toContain("grep -rl 'clipboard.writeText' /var/www/js");
        expect(dockerfile).toContain('COPY scripts/neko-client.js /var/www/ezil-input.js');
        expect(dockerfile).toContain('<script defer src="ezil-input.js"></script>');
    });
});

function clientFixture(touch = false, supportsClipboard = true) {
    const listeners: Record<string, Array<{ fn: Function; capture: boolean }>> = {};
    const synced: boolean[] = [];
    const warnings: string[] = [];
    const removed: string[] = [];
    let focused = 0;
    const overlay = {
        addEventListener(type: string, fn: Function, capture = false) {
            (listeners[type] ??= []).push({ fn, capture });
        },
        removeEventListener(type: string, fn: Function) {
            removed.push(type);
            listeners[type] = (listeners[type] ?? []).filter(l => l.fn !== fn);
        },
        focus() { focused++; },
    };
    let delivered = '';
    const input = (event: { data: string }) => { delivered += event.data; };
    overlay.addEventListener('input', input);
    overlay.addEventListener('compositionstart', () => overlay.removeEventListener('input', input));
    runInNewContext(script, {
        window: { $client: { $accessor: { settings: supportsClipboard ? { setClipboard: (v: boolean) => synced.push(v) } : {} } } },
        navigator: { maxTouchPoints: touch ? 1 : 0 },
        document: { querySelector: () => overlay },
        console: { warn: (message: string) => warnings.push(message) },
    });
    const emit = (type: string, event = {}) => {
        for (const capture of [true, false]) {
            for (const l of [...(listeners[type] ?? [])]) if (l.capture === capture) l.fn(event);
        }
    };
    return { synced, warnings, removed, overlay, input, emit, focused: () => focused, delivered: () => delivered };
}

it('never writes clipboard state (the legacy setClipboard takes text) and warns about nothing on load', () => {
    expect(clientFixture().synced).toEqual([]);
    expect(clientFixture(false, false).warnings).toEqual([]);
});

it('keeps plain Unicode input working after IME composition and allows listener cleanup', () => {
    const f = clientFixture();
    f.emit('compositionstart');
    f.emit('compositionend');
    f.emit('input', { data: 'éह中🙂' });
    expect(f.delivered()).toBe('éह中🙂');
    expect(f.removed).toEqual([]);
    f.overlay.removeEventListener('input', f.input);
    expect(f.removed).toEqual(['input']);
});

it('focuses the desktop textarea on a mouse click without raising a touch keyboard', () => {
    const f = clientFixture();
    f.emit('pointerdown', { pointerType: 'mouse' });
    expect(f.focused()).toBe(1);
    f.emit('pointerdown', { pointerType: 'touch' });
    expect(f.focused()).toBe(1);
});

it('leaves the existing mobile composition repair in charge on touch devices', () => {
    const f = clientFixture(true);
    f.emit('compositionstart');
    expect(f.removed).toEqual(['input']);
});

function hostingFixture({ connected = false, implicitHosting = true, readyState = 1,
    touch = false, overlayPresent = true, clientPresent = true } = {}) {
    const sockets: Array<{ readyState: number; sent: string[]; send: (text: string) => void }> = [];
    const newSocket = (state = 1) => {
        const socket = { readyState: state, sent: [] as string[], send(text: string) { this.sent.push(text); } };
        sockets.push(socket);
        return socket;
    };
    const uiCalls: string[] = [], nativeCalls: string[] = [], timers: Function[] = [];
    const remote = { implicitHosting, hosting: true, controlling: true,
        request() { uiCalls.push('request'); }, setClipboard() { uiCalls.push('clipboard'); } };
    const client = {
        _ws: newSocket(readyState), connected, $accessor: { remote },
        sendMessage() { throw new Error('sendMessage requires WebRTC'); },
        'system/init'(payload: { implicit_hosting?: boolean }) {
            expect(this).toBe(client);
            remote.implicitHosting = payload.implicit_hosting!;
            nativeCalls.push('init');
            return 'initialized';
        },
        CONNECTED() { expect(this).toBe(client); client.connected = true; nativeCalls.push('connected'); return 'connected'; },
        'control/locked'() { nativeCalls.push('locked'); },
    };
    const overlay = { addEventListener() {}, removeEventListener() {} };
    const window = { $client: clientPresent ? client : undefined, setTimeout(fn: Function) { timers.push(fn); } };
    const install = () => runInNewContext(script, { window,
        document: { querySelector: () => overlayPresent ? overlay : null },
        navigator: { maxTouchPoints: touch ? 1 : 0 }, console: { warn() {} } });
    install();
    return { client, remote, uiCalls, nativeCalls, sockets, timers, window, install,
        reconnect() { client.connected = false; client._ws = newSocket(); return client._ws; },
        init(value: unknown) { return client['system/init']({ implicit_hosting: value as boolean }); },
        requests: () => sockets.map(socket => socket.sent.map(text => JSON.parse(text))),
    };
}

describe('implicit clipboard hosting', () => {
    it('waits for server initialization despite the legacy true default, then sends before WebRTC connects', () => {
        const f = hostingFixture();
        expect(f.requests()).toEqual([[]]);
        expect(f.init(true)).toBe('initialized');
        expect(f.client.connected).toBe(false);
        expect(f.requests()).toEqual([[{ event: 'control/request' }]]);
        expect(f.uiCalls).toEqual([]);
        expect(f.nativeCalls).toEqual(['init']);
    });

    it('sends once on each reconnect, ignoring duplicate init, lock replies and repeated injection', () => {
        const f = hostingFixture();
        const lock = f.client['control/locked'];
        for (let index = 0; index < 3; index++) {
            if (index) f.reconnect();
            f.init(true); f.init(true); f.client.CONNECTED();
            f.client['control/locked'](); f.install();
        }
        expect(f.requests()).toEqual(Array.from({ length: 3 }, () => [{ event: 'control/request' }]));
        expect(f.client['control/locked']).toBe(lock);
        expect(f.uiCalls).toEqual([]);
        expect(f.timers).toEqual([]);
    });

    it('handles an already connected viewer and late injection between init and WebRTC completion', () => {
        const connected = hostingFixture({ connected: true });
        connected.install(); connected.client.CONNECTED();
        expect(connected.requests()).toEqual([[{ event: 'control/request' }]]);
        const connecting = hostingFixture();
        expect(connecting.client.CONNECTED()).toBe('connected');
        expect(connecting.requests()).toEqual([[{ event: 'control/request' }]]);
    });

    it('never requests control from an explicit host, including changed settings after reconnect', () => {
        for (const value of [false, undefined, null, 'true', 1]) {
            const f = hostingFixture();
            f.init(value); f.client.CONNECTED();
            expect(f.requests()).toEqual([[]]);
            expect(f.uiCalls).toEqual([]);
        }
        const f = hostingFixture({ connected: true, implicitHosting: false });
        expect(f.requests()).toEqual([[]]);
        f.reconnect(); f.init(true);
        f.reconnect(); f.init(false); f.client.CONNECTED();
        expect(f.requests()).toEqual([[], [{ event: 'control/request' }], []]);
    });

    it('sends only on an open socket', () => {
        for (const readyState of [0, 2, 3]) {
            const f = hostingFixture({ connected: true, readyState });
            f.init(true);
            expect(f.requests()).toEqual([[]]);
        }
        const f = hostingFixture({ readyState: 0 });
        f.client._ws.readyState = 1;
        f.init(true);
        expect(f.requests()).toEqual([[{ event: 'control/request' }]]);
    });

    it('does not retry a failed send until a new socket is initialized', () => {
        const f = hostingFixture();
        let sends = 0;
        f.client._ws.send = () => { sends++; throw new Error('socket closed'); };
        expect(() => f.init(true)).not.toThrow();
        f.init(true); f.client['control/locked'](); f.client.CONNECTED(); f.install();
        expect(sends).toBe(1);
        expect(f.timers).toEqual([]);
        f.reconnect(); f.init(true);
        expect(f.requests()).toEqual([[], [{ event: 'control/request' }]]);
    });

    it('installs before the overlay appears and also hosts on touch devices', () => {
        for (const options of [{ overlayPresent: false }, { touch: true }]) {
            const f = hostingFixture(options);
            f.init(true);
            expect(f.requests()).toEqual([[{ event: 'control/request' }]]);
        }
    });

    it('waits for a late client and installs only once across overlay retries', () => {
        const f = hostingFixture({ clientPresent: false, overlayPresent: false });
        f.window.$client = f.client;
        f.timers.shift()!(); f.init(true);
        f.timers.shift()!(); f.init(true);
        expect(f.requests()).toEqual([[{ event: 'control/request' }]]);
    });
});
