// Read-only observations; polling never advances allocation or migration.
import trpc from './Settings/trpc.js';

const stages = {
    operations_paused: ['Computer operations are paused', 'Check this view later. No transfer is currently running.'],
    needs_operator: ['Computer needs attention', 'An operator must resolve this before the transition can continue.'],
    queued: ['Waiting to start', 'The request is queued. No transfer is currently running.'],
    fenced: ['Workspace secured', 'Preparing the saved workspace for migration.'],
    exported: ['Workspace saved', 'The saved workspace is ready for the new computer.'],
    provisioning: ['Preparing computer', 'Waiting for the new computer before restoring the saved workspace.'],
    restored: ['Workspace restored', 'Waiting for the apps to connect.'],
    recovering: ['Recovering computer', 'Checking the saved transition before continuing.'],
    failed_reopened: ['Migration did not finish', 'The original computer was reopened. Check its current status before trying again.'],
    stopped: ['Computer stopped', 'Use the normal computer controls to start a session.'],
    leased: ['Preparing computer', 'A computer has been assigned; waiting for startup.'],
    starting: ['Starting computer', 'Startup is in progress. A finish time is not available.'],
    mounting: ['Attaching saved workspace', 'Reattaching the retained workspace volume, not copying it to a new workspace.'],
    running: ['Computer running', 'Waiting for this app to connect.'],
    draining: ['Saving the session', 'Waiting for the normal stop process to finish.'],
    stopping: ['Stopping computer', 'Waiting for the normal stop process to finish.'],
    retiring: ['Replacing computer', 'Waiting for the previous computer to retire.'],
    retired: ['Previous computer retired', 'Waiting for the current transition status.'],
    purge_eligible: ['Computer stopped', 'No active startup is recorded.'],
    warming: ['Preparing computer', 'Waiting for the computer’s startup checks.'],
    ready: ['Computer prepared', 'Waiting for this app to connect.'],
    claimed: ['Computer assigned', 'Waiting for this app to connect.'],
    unavailable: ['Progress unavailable', 'A current progress observation is not available.'],
};
const migrationSteps = ['queued', 'fenced', 'exported', 'provisioning', 'restored'];
export function progressView(data, computerId) {
    if (!data || data.version !== 1 || data.computerId !== computerId) return null;
    const stage = data.operationsPaused === true || data.paused === true || data.stage === 'operations_paused' ? 'operations_paused'
        : data.needsOperator === true || data.stage === 'needs_operator' ? 'needs_operator' : data.stage;
    if (!Object.hasOwn(stages, stage) || stage === 'unavailable') return null;
    const current = migrationSteps.indexOf(stage);
    const hardware = data.selectedNextOpenHardware;
    const next = hardware?.effective === 'next_open' && Number.isSafeInteger(hardware.vcpu) && hardware.vcpu > 0
        && Number.isFinite(hardware.memoryGiB) && hardware.memoryGiB > 0
        ? `Next session: ${hardware.vcpu} vCPU · ${hardware.memoryGiB} GiB memory. Applies after you stop this session and start again.` : '';
    return {
        stage, title: stages[stage][0], body: stages[stage][1],
        active: data.active === true && !['operations_paused', 'needs_operator', 'queued', 'unavailable', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        steps: data.operation === 'migration' && current >= 0 ? migrationSteps.map((key, i) => ({ label: stages[key][0], state: i < current ? 'complete' : i === current ? 'current' : 'pending' })) : [],
        guidance: data.operation === 'migration' && data.durable === true && data.resumePolicy === 'saved_workspace_only'
            ? 'You can reopen this view to check the saved migration. Unsaved changes inside apps are not guaranteed. Progress resumes only when operations allow it.' : '',
        next,
        updated: typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt))
            ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(data.updatedAt)) : null,
    };
}

export function observeComputerProgress({ computerId, element, onChange, query = trpc.query }) {
    let watching = false, generation = 0, timer, deadline;
    async function poll() {
        if (!watching || document.hidden || !element.isConnected) return;
        clearTimeout(timer);
        const own = ++generation;
        let ownDeadline;
        try {
            const result = await Promise.race([
                query('computer.progress', { computerId }),
                new Promise((_, reject) => { deadline = ownDeadline = setTimeout(() => reject(Error('timeout')), 15000); }),
            ]);
            if (watching && own === generation && element.isConnected) onChange(result.ok ? progressView(result.data, computerId) : null);
        } catch {
            if (watching && own === generation && element.isConnected) onChange(null);
        } finally {
            clearTimeout(ownDeadline);
            if (watching && own === generation && element.isConnected) timer = setTimeout(poll, 5000);
        }
    }
    const visibility = () => {
        if (document.hidden) { generation++; clearTimeout(timer); clearTimeout(deadline); onChange(null); }
        else void poll();
    };
    return {
        start() {
            if (watching || !computerId || !element.isConnected) return;
            watching = true; document.addEventListener('visibilitychange', visibility); void poll();
        },
        stop() {
            watching = false; generation++; clearTimeout(timer); clearTimeout(deadline);
            document.removeEventListener('visibilitychange', visibility);
        },
    };
}
