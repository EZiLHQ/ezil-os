import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface DeliveryProcess { quiescent: boolean; present: boolean; failed: boolean }

/** Fixed template instances only. Observations never start a unit. A successful
 * stop request alone is not proof: verify no pending job, PID or cgroup process. */
export class SystemdDelivery {
    private readonly prefix: string;
    constructor(privateValidationPrefix?: string, private readonly kind: 'configuration' | 'mount' = 'configuration') {
        if (!['configuration', 'mount'].includes(kind) || (privateValidationPrefix
            && !(kind === 'mount' ? /^ezil-mount-test-[a-f0-9]{32}$/ : /^ezil-config-test-[a-f0-9]{32}$/).test(privateValidationPrefix))) throw new Error('delivery_unit_invalid');
        this.prefix = privateValidationPrefix ?? (kind === 'mount' ? 'ezil-mount' : 'ezil-configuration');
    }
    unit(key: string) {
        const pattern = this.kind === 'mount' ? 'mount' : '(prepare|reload)';
        if (!new RegExp(`^${pattern}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(key)) throw new Error('delivery_unit_invalid');
        return `${this.prefix}@${key}.service`;
    }
    private async command(args: string[], timeout = 5000) {
        try { return (await exec('/usr/bin/systemctl', ['--no-pager', '--no-ask-password', ...args], {
            env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout, maxBuffer: 8192,
        })).stdout; }
        catch (error) {
            // show returns 4 for an absent unit while still returning its
            // typed properties. All other execution errors remain failures.
            const result = error as { code?: unknown; stdout?: unknown };
            if (args[0] === 'show' && result.code === 4 && typeof result.stdout === 'string') return result.stdout;
            throw new Error('delivery_systemd_unavailable');
        }
    }
    async start(key: string): Promise<void> { await this.command(['start', '--no-block', this.unit(key)]); }
    async observe(key: string): Promise<DeliveryProcess> {
        const unit = this.unit(key);
        const output = await this.command(['show', unit, '--property=LoadState,ActiveState,MainPID,Job,ControlGroup,Result,KillMode']);
        const fields = new Map(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        const loaded = fields.get('LoadState'), state = fields.get('ActiveState');
        if (!['loaded', 'not-found'].includes(loaded ?? '') || !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(state ?? '')
            || !/^\d+$/.test(fields.get('MainPID') ?? '') || !fields.has('Job') || !fields.has('ControlGroup')) throw new Error('delivery_observation_invalid');
        if (loaded === 'loaded' && fields.get('KillMode') !== 'control-group') throw new Error('delivery_unit_invalid');
        let quiescent = ['inactive', 'failed'].includes(state!) && fields.get('MainPID') === '0' && ['', '0'].includes(fields.get('Job')!);
        const group = fields.get('ControlGroup')!;
        if (group) {
            if (!group.startsWith('/system.slice/') || !group.endsWith(`/${unit}`) || group.split('/').some(part => part === '..')
                || !/^[/a-zA-Z0-9_.@\\-]+$/.test(group)) throw new Error('delivery_observation_invalid');
            try {
                const events = await readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8');
                if (!/^populated [01]$/m.test(events)) throw new Error('delivery_observation_invalid');
                quiescent = quiescent && /^populated 0$/m.test(events);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('delivery_observation_invalid'); }
        }
        return { quiescent, present: loaded === 'loaded', failed: state === 'failed' };
    }
    async stop(key: string): Promise<DeliveryProcess> {
        // A nonexistent unit is safe only when the caller has already committed
        // cancellation, which the executor checks before beginning any work.
        try { await this.command(['stop', this.unit(key)], 20000); } catch { /* observe actual state below */ }
        const state = await this.observe(key);
        if (!state.quiescent) throw new Error('delivery_stop_unconfirmed');
        return state;
    }
}
