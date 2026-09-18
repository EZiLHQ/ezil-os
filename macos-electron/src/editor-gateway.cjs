'use strict';
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const SECRET_HEADER = 'x-ezil-editor';
function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n\0]/.test(value)) return false;
  try {
    let pathname = value.split('?')[0];
    for (let i = 0; i < 3; i++) pathname = decodeURIComponent(pathname);
    if (/[\\%]/.test(pathname) || pathname.startsWith('//')) return false;
    const normalized = new URL(pathname, 'http://localhost').pathname;
    return !/^\/(?:proxy|absproxy)(?:\/|$)/i.test(normalized);
  } catch { return false; }
}
function strip(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !['origin', 'authorization', 'proxy-authorization', 'cookie', 'set-cookie', SECRET_HEADER, 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'].includes(key.toLowerCase())));
}
function equal(a, b) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function startGateway({ socketPath, cookie, getEditor, shellOrigin, webContentsId, shellWebContents, createServer = http.createServer, request = http.request }) {
  const secret = randomBytes(32).toString('base64url'), sockets = new Set(); let closed = false;
  let origin;
  function permitted(req) {
    return !closed && (!getEditor || getEditor()?.state === 'ready') && req.headers.host === new URL(origin).host && req.headers.origin === shellOrigin && equal(req.headers[SECRET_HEADER], secret) && safePath(req.url);
  }
  function options(req) {
    // Fixed Unix socket only; there is no caller-supplied upstream host or port.
    const editor = getEditor?.();
    return { socketPath: editor?.socketPath || socketPath, path: req.url, method: req.method, headers: { ...strip(req.headers), host: new URL(origin).host, origin, cookie: editor?.cookie || cookie } };
  }
  function responseHeaders(headers) {
    const clean = strip(headers);
    if (clean.location) {
      const target = new URL(clean.location, origin);
      if (target.origin !== origin || !safePath(target.pathname)) throw Error('Unsafe redirect');
      clean.location = target.pathname + target.search + target.hash;
    }
    clean['cache-control'] = 'no-store';
    clean['referrer-policy'] = 'no-referrer';
    clean['content-security-policy'] = `${String(clean['content-security-policy'] || '').replace(/frame-ancestors[^;]*(?:;|$)/gi, '')}; frame-ancestors ${shellOrigin}`;
    delete clean['x-frame-options'];
    return clean;
  }
  const server = createServer((req, res) => {
    if (!permitted(req)) { res.writeHead(403).end(); return; }
    const upstream = request(options(req), response => {
      try { res.writeHead(response.statusCode, responseHeaders(response.headers)); }
      catch { response.destroy(); res.writeHead(502).end(); return; }
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!permitted(req) || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = request(options(req));
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote); remote.once('close', () => sockets.delete(remote));
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.once('close', () => remote.destroy()); remote.once('close', () => socket.destroy());
      const headers = strip(response.headers);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy()); upstream.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    headers(details) {
      const headers = strip(details.requestHeaders || {});
      const target = new URL(details.url);
      const targetOrigin = target.origin.replace(/^ws:/, 'http:');
      const source = details.initiator || details.origin || details.frame?.url || details.referrer;
      let sourceOrigin; try { sourceOrigin = new URL(source).origin; } catch {}
      if (shellWebContents) {
        if (shellWebContents.isDestroyed() || new URL(shellWebContents.mainFrame.url).origin !== shellOrigin) return headers;
        if (details.resourceType === 'subFrame' && details.frame?.parent === shellWebContents.mainFrame) sourceOrigin = shellOrigin;
      }
      if (closed || details.webContentsId !== webContentsId || targetOrigin !== origin || ![shellOrigin, origin].includes(sourceOrigin) || !safePath(target.pathname)) return headers;
      return { ...headers, [SECRET_HEADER]: secret, Origin: shellOrigin };
    },
    close() { closed = true; cookie = ''; for (const socket of sockets) socket.destroy(); server.close(); }
  };
}
module.exports = { startGateway, safePath, strip };
