import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/neko-branding/www/ezil-mobile.js', import.meta.url), 'utf8');
function fixture(stats?: () => Promise<Map<string, unknown>>) {
  const intervals = new Map<object, { fn: () => void; ms: number }>();
  const listeners = new Map<string, (event: unknown) => void>();
  const messages: { type?: string; vitals?: { framesDecoded: number; localCandidateType?: string; relayProtocol?: string } }[] = [];
  let frames = 0;
  class Peer {
    connectionState = 'connected';
    setRemoteDescription() { return Promise.resolve(); }
    addEventListener() {}
    getStats() {
      if (stats) return stats();
      frames++;
      return Promise.resolve(new Map([['video', { type: 'inbound-rtp', kind: 'video',
        framesDecoded: frames, bytesReceived: frames * 100, frameWidth: 1280, frameHeight: 720 }]]));
    }
  }
  const parent = { postMessage: (message: typeof messages[number]) => messages.push(message) };
  const window = { parent, location: { href: 'https://viewer.example/?ezilAttempt=current' },
    RTCPeerConnection: Peer, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) };
  vm.runInNewContext(source, { window, URL, navigator: { maxTouchPoints: 0 }, console,
    document: { querySelector: () => ({ readyState: 4, videoWidth: 1280, videoHeight: 720 }) },
    setInterval: (fn: () => void, ms: number) => { const id = {}; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id: object) => intervals.delete(id) });
  const peer = new Peer();
  peer.setRemoteDescription();
  return { messages, intervals, replacePeer: () => { const replacement = new Peer(); replacement.setRemoteDescription(); },
    send: (type: string, attempt?: string, origin: object = parent) => listeners.get('message')?.({
      source: origin, data: { source: 'ezil-shell', type, attempt },
    }),
    tick: async () => { intervals.forEach(timer => { if (timer.ms === 2000) timer.fn(); }); await Promise.resolve(); },
  };
}
describe('viewer frame evidence survives System monitor close', () => {
  it('continues decoded-frame progress for the current viewer after vitals_stop', async () => {
    const f = fixture();
    f.send('viewer_probe', 'current'); await Promise.resolve();
    const before = f.messages.at(-1)?.vitals?.framesDecoded;
    expect(before).toBe(1);
    f.send('vitals_start'); f.send('vitals_stop');
    await f.tick();
    expect(f.messages.at(-1)?.vitals?.framesDecoded).toBeGreaterThan(before!);
    expect([...f.intervals.values()].filter(timer => timer.ms === 2000)).toHaveLength(1);
  });
  it('stale or unrelated probes cannot retain a monitor-only subscription', async () => {
    const f = fixture();
    f.send('viewer_probe', 'old'); f.send('viewer_probe', 'current', {});
    f.send('vitals_start'); await Promise.resolve();
    f.send('vitals_stop');
    const count = f.messages.length;
    await f.tick();
    expect(f.messages).toHaveLength(count);
    expect([...f.intervals.values()].filter(timer => timer.ms === 2000)).toHaveLength(0);
  });
});

describe('TURN evidence identifies the pair carrying the current video', () => {
  const report = (videoTransport = true) => new Map<string, unknown>([
    ['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 2, bytesReceived: 200,
      frameWidth: 1280, frameHeight: 720, ...(videoTransport ? { transportId: 'video-transport' } : {}) }],
    ['video-transport', { type: 'transport', selectedCandidatePairId: 'active-pair' }],
    ['active-pair', { type: 'candidate-pair', state: 'succeeded', nominated: true,
      localCandidateId: 'active-local', remoteCandidateId: 'active-remote' }],
    ['active-local', { candidateType: 'relay', relayProtocol: 'tls' }],
    ['active-remote', { candidateType: 'host' }],
    // Deliberately last: the old implementation chose this nominated pair.
    ['old-pair', { type: 'candidate-pair', state: 'succeeded', nominated: true,
      localCandidateId: 'old-local', remoteCandidateId: 'old-remote' }],
    ['old-local', { candidateType: 'host', relayProtocol: 'udp' }],
    ['old-remote', { candidateType: 'relay' }],
  ]);
  it('uses the video transport selection even when another nominated pair appears later', async () => {
    const f = fixture(async () => report());
    f.send('viewer_probe', 'current'); await Promise.resolve();
    expect(f.messages.at(-1)?.vitals).toMatchObject({ localCandidateType: 'relay', relayProtocol: 'tls' });
  });
  it('cannot infer selected TURN from nomination alone', async () => {
    const f = fixture(async () => report(false));
    f.send('viewer_probe', 'current'); await Promise.resolve();
    expect(f.messages.at(-1)?.vitals?.localCandidateType).toBeUndefined();
    expect(f.messages.at(-1)?.vitals?.relayProtocol).toBeUndefined();
  });
  it('retains explicit legacy selection without using an unrelated transport', async () => {
    const stats = report(false);
    Object.assign(stats.get('active-pair') as object, { selected: true });
    const f = fixture(async () => stats);
    f.send('viewer_probe', 'current'); await Promise.resolve();
    expect(f.messages.at(-1)?.vitals).toMatchObject({ localCandidateType: 'relay', relayProtocol: 'tls' });
  });
  it('discards a delayed stats report from a replaced peer', async () => {
    let finish!: (report: Map<string, unknown>) => void;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    f.send('viewer_probe', 'current');
    f.replacePeer(); finish(report()); await Promise.resolve();
    expect(f.messages).toHaveLength(0);
  });
});
