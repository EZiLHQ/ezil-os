'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { startGateway, safePath } = require('../src/editor-gateway.cjs');
const { login } = require('../src/editor.cjs');
function transport() {
  let handler; const server = new EventEmitter(), requests = [];
  Object.assign(server, { listen: (_port, _host, cb) => cb(), address: () => ({ port: 12345 }), close() {} });
  let answer = { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['session=secret'] }, body: 'stream-response' };
  return {
    server, requests, setAnswer: value => { answer = value; }, createServer: callback => { handler = callback; return server; },
    request: (options, callback) => {
      requests.push(options); const upstream = new PassThrough();
      if (callback) process.nextTick(() => {
        const response = Readable.from([answer.body]); Object.assign(response, { statusCode: answer.status, headers: answer.headers }); callback(response);
      });
      else process.nextTick(() => {
        const remote = new PassThrough(); remote.on('data', () => {});
        upstream.emit('upgrade', { headers: { upgrade: 'websocket', connection: 'Upgrade', 'set-cookie': ['secret'], authorization: 'secret' } }, remote, Buffer.from('upgrade-head'));
      });
      return upstream;
    },
    async send(headers, url = '/?folder=hello%20world', method = 'GET') {
      const req = Readable.from(['body']); Object.assign(req, { headers, url, method });
      const res = new PassThrough(); let status = 200, responseHeaders, content = '';
      res.writeHead = (code, values) => { status = code; responseHeaders = values; res.headersSent = true; return res; };
      res.on('data', chunk => { content += chunk.toString(); });
      await new Promise(resolve => { res.on('finish', resolve); handler(req, res); });
      return { status, headers: responseHeaders, body: content };
    }
  };
}
test('gateway binds exact webContents/origin, strips credentials, preserves streams and queries', async t => {
  const wire = transport(), shellOrigin = 'http://127.0.0.1:3210';
  const gateway = await startGateway({ socketPath: '/private/editor.sock', cookie: 'session=upstream', shellOrigin, webContentsId: 7, ...wire }); t.after(() => gateway.close());
  const details = { url: gateway.origin + '/?folder=a%20b', webContentsId: 7, initiator: shellOrigin, requestHeaders: { Authorization: 'forged', cookie: 'forged', Origin: 'forged' } };
  const headers = gateway.headers(details); assert.equal(headers.Authorization, undefined); assert.equal(headers.cookie, undefined);
  const requestHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])); requestHeaders.host = new URL(gateway.origin).host;
  assert.equal((await wire.send({ host: requestHeaders.host, origin: shellOrigin })).status, 403);
  for (const override of [{ webContentsId: 8 }, { initiator: 'https://evil.test' }, { url: 'http://127.0.0.1:12346/' }]) assert.equal(gateway.headers({ ...details, ...override })['x-ezil-editor'], undefined);
  for (const headers of [{ ...requestHeaders, origin: 'https://evil.test' }, { ...requestHeaders, host: 'evil.test' }]) assert.equal((await wire.send(headers)).status, 403);
  const response = await wire.send(requestHeaders); assert.equal(response.status, 200); assert.equal(response.body, 'stream-response'); assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(wire.requests[0].socketPath, '/private/editor.sock'); assert.equal(wire.requests[0].path, '/?folder=hello%20world'); assert.equal(wire.requests[0].headers.cookie, 'session=upstream'); assert.equal(wire.requests[0].headers.authorization, undefined); assert.equal(wire.requests[0].headers['x-ezil-editor'], undefined);
  assert.equal(JSON.stringify(gateway).includes('upstream'), false);
  wire.setAnswer({ status: 302, headers: { location: '/next?q=a%20b' }, body: '' });
  assert.equal((await wire.send(requestHeaders)).headers.location, '/next?q=a%20b');
  wire.setAnswer({ status: 302, headers: { location: 'https://evil.test/path' }, body: '' }); assert.equal((await wire.send(requestHeaders)).status, 502);
  gateway.close(); assert.equal(gateway.headers(details)['x-ezil-editor'], undefined);
});
test('gateway rejects proxy routes, encoded bypasses, arbitrary targets and bad paths', () => {
  for (const value of ['https://evil.test/', '//evil.test/', '/proxy/3000/', '/absproxy/3000/', '/%70roxy/3000/', '/x/../proxy/3000', '/%2570roxy/3000', '/\\evil.test', '/\r\nHost: evil']) assert.equal(safePath(value), false, value);
  for (const value of ['/', '/stable/web.js?v=a%20b', '/?folder=%2FUsers%2Ftest', '/websocket?reconnectionToken=opaque']) assert.equal(safePath(value), true);
});
test('gateway authenticates websocket upgrades and forwards head buffers without cookies', async t => {
  const wire = transport(), shellOrigin = 'http://127.0.0.1:3210';
  const gateway = await startGateway({ socketPath: '/private/editor.sock', cookie: 'session=upstream', shellOrigin, webContentsId: 7, ...wire }); t.after(() => gateway.close());
  function socket() {
    const value = new EventEmitter(); value.output = '';
    value.write = data => { value.output += data.toString(); }; value.end = data => { value.output += data || ''; }; value.destroy = () => { value.destroyed = true; }; value.pipe = () => {}; return value;
  }
  const forbidden = socket(); wire.server.emit('upgrade', { headers: { host: '127.0.0.1:12345' }, url: '/' }, forbidden, Buffer.alloc(0)); assert.match(forbidden.output, /403/); assert.equal(wire.requests.length, 0);
  const headers = gateway.headers({ url: gateway.origin.replace('http:', 'ws:') + '/ws?q=preserved', webContentsId: 7, initiator: shellOrigin, requestHeaders: { upgrade: 'websocket', connection: 'Upgrade' } });
  const rawHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])); rawHeaders.host = '127.0.0.1:12345';
  const client = socket(); wire.server.emit('upgrade', { headers: rawHeaders, url: '/ws?q=preserved', method: 'GET' }, client, Buffer.from('client-head'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(client.output, /101 Switching Protocols/); assert.match(client.output, /upgrade-head/); assert.doesNotMatch(client.output, /secret|set-cookie|authorization/); assert.equal(wire.requests[0].path, '/ws?q=preserved');
});
test('editor login submits password only in a UDS POST body and retains cookie in main', async () => {
  let options, body;
  const cookie = await login('/private/editor.sock', 'short-secret', (value, callback) => {
    options = value; const req = new EventEmitter(); req.setTimeout = () => {}; req.end = value => {
      body = value; callback({ statusCode: 302, headers: { 'set-cookie': ['code-server-session=opaque; HttpOnly; SameSite=Lax'] }, resume() {} });
    }; return req;
  });
  assert.equal(options.socketPath, '/private/editor.sock'); assert.equal(options.path, '/login'); assert.equal(options.method, 'POST'); assert.equal(body, 'password=short-secret'); assert.equal(cookie, 'code-server-session=opaque'); assert.ok(!JSON.stringify(options).includes('short-secret'));
});
test('real UDS gateway forwards authenticated HTTP and a WebSocket upgrade', { timeout: 10000 }, async t => {
  const http = require('node:http'), net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-wire-'))), socketPath = path.join(root, 'upstream.sock');
  const sockets = new Set(); let gateway, observedPath;
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, 'session=upstream'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['x-ezil-editor'], undefined);
    observedPath = req.url;
    res.setHeader('set-cookie', 'session=must-not-leak'); res.write('chunk-one'); res.end('path-preserved');
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/socket?reconnect=preserved'); assert.equal(req.headers.cookie, 'session=upstream');
    const accept = require('node:crypto').createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: must-not-leak\r\n\r\n`);
    socket.write(Buffer.from([0x81, 2, 0x4f, 0x4b])); if (head.length) socket.write(head);
  });
  t.after(() => { gateway?.close(); for (const socket of sockets) socket.destroy(); upstream.close(); fs.rmSync(root, { recursive: true, force: true }); });
  try { await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(socketPath, resolve); }); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Socket listeners denied by sandbox; hosted Mac gate required'); return; } throw error; }
  const shellOrigin = 'http://127.0.0.1:3210';
  gateway = await startGateway({ socketPath, cookie: 'session=upstream', shellOrigin, webContentsId: 7 });
  const headers = gateway.headers({ url: gateway.origin + '/?q=kept', webContentsId: 7, initiator: shellOrigin, requestHeaders: {} });
  const response = await fetch(gateway.origin + '/?q=kept', { headers }); assert.equal(response.status, 200); assert.equal(await response.text(), 'chunk-onepath-preserved'); assert.equal(observedPath, '/?q=kept'); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await fetch(gateway.origin)).status, 403);
  const port = Number(new URL(gateway.origin).port);
  const upgraded = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); sockets.add(socket); let response = Buffer.alloc(0);
    socket.once('error', reject); socket.once('connect', () => socket.write(`GET /socket?reconnect=preserved HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${shellOrigin}\r\nx-ezil-editor: ${headers['x-ezil-editor']}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', chunk => { response = Buffer.concat([response, chunk]); if (response.includes(Buffer.from([0x81, 2, 0x4f, 0x4b]))) { socket.destroy(); resolve(response.toString()); } });
  });
  assert.match(upgraded, /101 Switching Protocols/); assert.doesNotMatch(upgraded, /must-not-leak/i);
});
