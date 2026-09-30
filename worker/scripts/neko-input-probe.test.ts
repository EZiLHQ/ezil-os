import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { composedWordPassed, nekoInputState, probeComposedWord } from '../../e2e/neko-input-probe.mjs';

// Faults in the verifier must not turn a broken channel into a passing release.
// This harness tests that verifier; it does not simulate remote XTEST delivery.
function harness(options: {
    state?: string; ice?: string; hosting?: boolean; locked?: boolean;
    failAt?: number; wrongKeyup?: boolean; malformed?: boolean;
    duplicate?: boolean; replaceChannel?: boolean; throwDispatch?: boolean;
} = {}) {
    const errors = new Set<() => void>();
    let calls = 0;
    class Channel {
        readyState = options.state ?? 'open';
        send(_data: unknown) {
            if (++calls === options.failAt) throw new Error('private diagnostic detail');
        }
    }
    const channel = new Channel();
    const original = Channel.prototype.send;
    const client = {
        socketOpen: true,
        _channel: channel,
        _peer: { iceConnectionState: options.ice ?? 'connected' },
        $accessor: { remote: { hosting: options.hosting ?? true, locked: options.locked ?? false } },
    };
    const textarea = {
        value: '', focus() {},
        dispatchEvent(event: { type: string }) {
            if (options.throwDispatch) throw new Error('private event detail');
            if (event.type !== 'compositionend') return;
            try {
                for (const char of options.duplicate ? 'fastfast' : 'fast') {
                    for (const opcode of [3, 4]) {
                        // Include a backing-buffer offset, as typed views can
                        // refer to a packet inside a larger transport buffer.
                        const bytes = new Uint8Array(new ArrayBuffer(20), 4, 11);
                        bytes[0] = opcode;
                        bytes[1] = options.malformed ? 1 : 8;
                        new DataView(bytes.buffer, 4, 11).setBigUint64(3,
                            BigInt(options.wrongKeyup && opcode === 4 ? 1 : char.codePointAt(0)!), true);
                        channel.send(bytes);
                    }
                }
                if (options.replaceChannel) client._channel = new Channel();
            } catch {
                // Like browser event listeners: errors are reported on window,
                // rather than rethrown by dispatchEvent to its caller.
                for (const listener of errors) listener();
            }
        },
    };
    class Event {
        constructor(public type: string, data: object) { Object.assign(this, data); }
    }
    const context = {
        window: {
            $client: client,
            addEventListener(_type: string, listener: () => void) { errors.add(listener); },
            removeEventListener(_type: string, listener: () => void) { errors.delete(listener); },
        },
        document: { querySelector: () => textarea },
        RTCDataChannel: Channel, KeyboardEvent: Event, InputEvent: Event, CompositionEvent: Event,
        ArrayBuffer, Uint8Array, DataView,
        setTimeout(callback: () => void) { callback(); },
    };
    return {
        state: () => runInNewContext(`(${nekoInputState.toString()})()`, context),
        probe: () => runInNewContext(`(${probeComposedWord.toString()})()`, context),
        restored: () => Channel.prototype.send === original && errors.size === 0,
    };
}

describe('Neko production input verification', () => {
    for (const options of [
        { state: 'connecting' }, { state: 'closed' }, { ice: 'checking' },
        { ice: 'disconnected' }, { hosting: false }, { locked: true },
    ]) {
        it(`does not type before input is ready: ${JSON.stringify(options)}`, async () => {
            const test = harness(options);
            expect(test.state().ready).toBe(false);
            const result = await test.probe();
            expect(result.error).toBe('input_not_ready');
            expect(result.frames).toEqual([]);
            expect(composedWordPassed(result)).toBe(false);
            expect(test.restored()).toBe(true);
        });
    }

    it('accepts exactly the successful key pairs, including completed ICE', async () => {
        const test = harness({ ice: 'completed' });
        expect(test.state().ready).toBe(true);
        expect(composedWordPassed(await test.probe())).toBe(true);
        expect(test.restored()).toBe(true);
    });

    it('does not count a throwing send as a delivered keydown', async () => {
        const test = harness({ failAt: 1 });
        const result = await test.probe();
        expect(result.frames).toEqual([]);
        expect(result.sendErrors).toBe(1);
        expect(result.pageErrors).toBe(1);
        expect(JSON.stringify(result)).not.toContain('private');
        expect(composedWordPassed(result)).toBe(false);
        expect(test.restored()).toBe(true);
    });

    for (const options of [
        { failAt: 2 }, { wrongKeyup: true }, { malformed: true },
        { duplicate: true }, { replaceChannel: true },
    ]) {
        it(`rejects incomplete or invalid delivery: ${JSON.stringify(options)}`, async () => {
            const test = harness(options);
            expect(composedWordPassed(await test.probe())).toBe(false);
            expect(test.restored()).toBe(true);
        });
    }

    it('restores instrumentation even if dispatch itself throws', async () => {
        const test = harness({ throwDispatch: true });
        await expect(test.probe()).rejects.toThrow();
        expect(test.restored()).toBe(true);
    });
});
