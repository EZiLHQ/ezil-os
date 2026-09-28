'use strict';
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
// Exercise the real broker request handler without binding a socket. The
// worker sandbox denies listen(2); hosted/physical Electron tests bind sockets.
function harness() {
  let handler;
  const server = new EventEmitter();
  Object.assign(server, { listen: (_port, _host, cb) => cb(), address: () => ({ port: 12345 }), closeAllConnections() {}, close() {} });
  return {
    createServer: callback => { handler = callback; return server; },
    request: async (url, options = {}) => {
      const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
      Object.assign(req, { url, method: options.method || 'GET', headers: { host: '127.0.0.1:12345', ...options.headers } });
      const res = new EventEmitter(), chunks = [], headers = new Headers(); let code = 200, destroyed = false;
      Object.assign(res, {
        headersSent: false,
        setHeader(name, value) { headers.set(name, value); },
        writeHead(status, values = {}) { code = status; for (const [name, value] of Object.entries(values)) headers.set(name, value); this.headersSent = true; return this; },
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
        end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return this; },
        destroy() { destroyed = true; this.emit('close'); }
      });
      options.onResponse?.(res);
      await handler(req, res);
      return { status: code, headers, destroyed, text: async () => Buffer.concat(chunks).toString(), json: async () => JSON.parse(Buffer.concat(chunks).toString()) };
    }
  };
}
module.exports = { harness };
