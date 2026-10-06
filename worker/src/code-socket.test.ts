import { describe, expect, it } from 'bun:test';
import { pipeCodeSockets, bridgeCodeSocket } from './code-socket';

class Socket extends EventTarget {
  accepted = false;
  sent: unknown[] = [];
  closed: {code?: number; reason?: string}[] = [];
  accept() { this.accepted = true; }
  send(data: unknown) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed.push({code, reason}); }
  emit(type: string, values: object = {}) { this.dispatchEvent(Object.assign(new Event(type), values)); }
}
describe('Code socket bridge', () => {
  it('accepts both ends, forwards text and binary in both directions and records activity', async () => {
    const client = new Socket(), upstream = new Socket(); let activity = 0;
    pipeCodeSockets(client as unknown as WebSocket, upstream as unknown as WebSocket, () => activity++);
    expect(client.accepted && upstream.accepted).toBe(true);
    client.emit('message', {data:'input'}); upstream.emit('message', {data:new Uint8Array([1,2]).buffer});
    upstream.emit('message', {data:new Blob(['output'])});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upstream.sent).toEqual(['input']);
    expect(new Uint8Array(client.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([1,2]));
    expect(new TextDecoder().decode(client.sent[1] as ArrayBuffer)).toBe('output');
    expect(activity).toBe(3);
  });
  it('propagates close and failure in either direction without invalid close codes', () => {
    const client = new Socket(), upstream = new Socket();
    pipeCodeSockets(client as unknown as WebSocket, upstream as unknown as WebSocket, () => {});
    client.emit('close', {code:1006,reason:''}); upstream.emit('close',{code:1001,reason:'leaving'});
    expect(upstream.closed[0]).toEqual({code:1000,reason:''});
    expect(client.closed[0]).toEqual({code:1001,reason:'leaving'});
    upstream.emit('error'); expect(client.closed[1]?.code).toBe(1011);
  });
  it('preserves ordinary upstream responses', () => {
    const response = new Response('not running', {status:409});
    expect(bridgeCodeSocket(response, () => {})).toBe(response);
  });
});
