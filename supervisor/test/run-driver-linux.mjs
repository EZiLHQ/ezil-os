import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
const hostImage = docker(['image', 'inspect', base, '--format', '{{.Id}}']).trim();
const root = `/run/ezil-driver-test-${randomUUID()}`;
const name = `ezil-driver-test-${randomUUID()}`;
const code = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'ezil-driver-fixture-'));
let image = process.env.EZIL_TEST_RETICLE_IMAGE;
try {
    if (!image) {
        writeFileSync(join(fixture, 'Dockerfile'), `FROM ${base}\nCOPY main.mjs /opt/app/main.mjs\n`);
        writeFileSync(join(fixture, 'main.mjs'), `import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
const server=createServer(async(req,res) => {
  if(req.url === '/status') return res.end('ok');
  if(req.url === '/save' && req.method === 'POST') {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    writeFileSync('/data/reticle/value',Buffer.concat(chunks));
    const fd=openSync('/data/reticle/value','r');fsyncSync(fd);closeSync(fd);return res.end('saved');
  }
  if(req.url === '/value') return res.end(readFileSync('/data/reticle/value'));
  res.statusCode=404;res.end();
});
server.on('upgrade',(req,socket) => {
  if(req.url !== '/ws') return socket.destroy();
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
  socket.on('data',()=>socket.write(Buffer.from([129,4,112,111,110,103])));
  socket.on('error',()=>socket.destroy());
});
server.listen(Number(process.env.PORT),'0.0.0.0');`);
        image = docker(['build', '--platform', 'linux/amd64', '--quiet', fixture]).trim();
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('immutable_test_image_required');
    const output = docker(['run', '--platform', 'linux/amd64', '--name', name, '--privileged', '--network', 'host',
        '--volume', `${root}:${root}:rshared`, '--volume', '/var/run/docker.sock:/var/run/docker.sock',
        '--mount', `type=bind,src=${code},dst=/code,readonly`,
        '--env', `EZIL_TEST_ROOT=${root}`, '--env', `EZIL_TEST_IMAGE=${image}`,
        '--env', `EZIL_TEST_RETICLE=${process.env.EZIL_TEST_RETICLE_IMAGE ? '1' : '0'}`,
        '--entrypoint', 'node', hostImage, '/code/test/driver.linux.mjs']);
    process.stdout.write(output);
} finally {
    docker(['rm', '-f', name]);
    rmSync(fixture, { recursive: true });
    // The test image has no tag and can be reused from Docker's build cache.
}
