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
