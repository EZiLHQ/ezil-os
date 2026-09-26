import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { signControlRequest } from './control-auth.js';
import { canonicalJson } from './control-protocol.js';
import { descriptor, type Delivery } from './configuration-delivery-contract.js';

const exec = promisify(execFile), unit = 'ezil-supervisor.service';
async function systemctl(args: string[], signal: AbortSignal) {
    try { return (await exec('/usr/bin/systemctl', ['--no-pager', '--no-ask-password', ...args, unit], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 80000, maxBuffer: 8192, signal,
    })).stdout; } catch { throw new Error('supervisor_start_unconfirmed'); }
}
/** Observations never start or enable the unit. The PID, pending job and
 * cgroup matter: systemctl's acknowledgement is not an application receipt. */
export async function observeSupervisor(signal: AbortSignal) {
    const output = await systemctl(['show', '--property=LoadState,ActiveState,MainPID,Job,ControlGroup,KillMode'], signal);
    const fields = new Map(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    const state = fields.get('ActiveState'), pid = fields.get('MainPID'), job = fields.get('Job'), group = fields.get('ControlGroup');
    if (fields.get('LoadState') !== 'loaded' || fields.get('KillMode') !== 'mixed' || !/^\d+$/.test(pid ?? '')
        || job === undefined || group === undefined || !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(state ?? '')) throw new Error('supervisor_state_invalid');
    let empty = !group;
    if (group) {
        if (group !== `/system.slice/${unit}`) throw new Error('supervisor_state_invalid');
        try {
            const events = await readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8');
            if (!/^populated [01]$/m.test(events)) throw new Error();
            empty = /^populated 0$/m.test(events);
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('supervisor_state_invalid'); empty = true; }
    }
    return { active: state === 'active' && Number(pid) > 0 && ['', '0'].includes(job),
        stopped: ['inactive', 'failed'].includes(state!) && pid === '0' && ['', '0'].includes(job) && empty };
}
export async function requestSupervisorStart(signal: AbortSignal) { await systemctl(['start', '--no-block'], signal); }
export async function stopSupervisor() {
    const signal = AbortSignal.timeout(85000);
    try { await systemctl(['stop'], signal); } catch { /* Observe the actual result even after a lost reply. */ }
    if (!(await observeSupervisor(signal)).stopped) throw new Error('supervisor_stop_unconfirmed');
}

async function configurationProbe(value: Delivery, secret: Buffer, signal: AbortSignal): Promise<boolean> {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: randomUUID(),
        computerId: value.scope.computerId, computerGeneration: value.scope.computerGeneration, operation: 'configuration' }));
    const agent = new Agent({ keepAlive: false });
    try {
        return await new Promise<boolean>((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port: 8181, method: 'POST', path: '/v1/control', agent,
                signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), headers: { 'content-type': 'application/json',
                    'content-length': String(body.length), ...signControlRequest('POST', '/v1/control', body, secret) } }, response => {
                if (response.statusCode === 503) { response.destroy(); resolve(false); return; }
                if (response.statusCode !== 200) { response.destroy(); reject(new Error('supervisor_configuration_unconfirmed')); return; }
                const chunks: Buffer[] = []; let size = 0;
                response.on('data', (chunk: Buffer) => { size += chunk.length;
                    if (size > 4096) { response.destroy(); reject(new Error('supervisor_configuration_unconfirmed')); }
                    else chunks.push(chunk); });
                response.once('error', () => reject(new Error('supervisor_configuration_unconfirmed')));
                response.once('end', () => {
                    try { if (canonicalJson(JSON.parse(Buffer.concat(chunks).toString())) !== canonicalJson(descriptor(value))) throw new Error(); resolve(true); }
                    catch { reject(new Error('supervisor_configuration_unconfirmed')); }
                });
            });
            req.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' && !signal.aborted
                ? resolve(false) : reject(new Error('supervisor_configuration_unconfirmed')));
            req.end(body);
        });
    } finally { agent.destroy(); }
}
export async function confirmSupervisor(value: Delivery, secret: Buffer, signal: AbortSignal, check: () => Promise<void>) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    while (!bounded.aborted) {
        await check();
        const state = await observeSupervisor(bounded);
        if (state.stopped) throw new Error('supervisor_configuration_unconfirmed');
        if (state.active && await configurationProbe(value, secret, bounded)) { await check(); return; }
        await delay(100, undefined, { signal: bounded });
    }
    throw new Error('supervisor_configuration_unconfirmed');
}
