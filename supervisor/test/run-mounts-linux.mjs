import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const base = 'node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
const image = docker(['image', 'inspect', base, '--format', '{{.Id}}']).trim();
const root = `/run/ezil-mount-test-${randomUUID()}`;
const name = `ezil-mount-test-${randomUUID()}`;
const code = fileURLToPath(new URL('..', import.meta.url));
try {
    // Privilege belongs only to the Linux host harness. Reader applications
    // are unprivileged, have no socket, and run on network=none. Shared mount
    // propagation makes staged binds visible to the actual Docker daemon.
    const output = docker(['run', '--platform', 'linux/amd64', '--name', name, '--privileged', '--network', 'none',
        '--volume', `${root}:${root}:rshared`, '--volume', '/var/run/docker.sock:/var/run/docker.sock',
        '--mount', `type=bind,src=${code},dst=/code,readonly`,
        '--env', `EZIL_TEST_ROOT=${root}`, '--env', `EZIL_TEST_IMAGE=${image}`,
        '--entrypoint', 'node', image, '/code/test/mounts.linux.mjs']);
    process.stdout.write(output);
} finally {
    docker(['rm', '-f', name]);
}
