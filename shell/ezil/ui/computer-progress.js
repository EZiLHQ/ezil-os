// Read-only observations; polling never advances allocation or migration.
import trpc from './Settings/trpc.js';

const stages = {
    operations_paused: ['Computer startup is temporarily paused', 'Check this view later for an update.'],
    needs_operator: ['Computer needs attention', 'Check the computer’s current status before trying again.'],
    queued: ['Waiting to start', 'Waiting for the saved request to begin.'],
    requested: ['Saving your files', 'Preparing the saved workspace for migration.'],
    fenced: ['Workspace secured', 'Preparing the saved workspace for migration.'],
    exported: ['Workspace saved', 'The saved workspace is ready for the new computer.'],
    provisioning: ['Preparing computer', 'Waiting for the new computer before restoring the saved workspace.'],
    restored: ['Workspace restored', 'Waiting for the apps to connect.'],
    committed: ['Starting your desktop', 'Waiting for the apps to connect.'],
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
const migrationSteps = ['Saving your files', 'Getting your AWS computer', 'Moving your files', 'Starting your desktop'];
const migrationStages = { requested: 0, fenced: 0, exported: 1, provisioning: 1, restored: 2, committed: 3, mounting: 3, starting: 3, running: 3 };
const formatBytes = bytes => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
export function progressView(data, computerId) {
    if (!data || ![1, 2].includes(data.version) || data.computerId !== computerId) return null;
    const stage = data.operationsPaused === true || data.paused === true || data.stage === 'operations_paused' ? 'operations_paused'
        : data.needsOperator === true || ['needs_operator', 'failed_needs_operator'].includes(data.stage) ? 'needs_operator' : data.stage;
    if (!Object.hasOwn(stages, stage) || stage === 'unavailable') return null;
    const current = data.operation === 'migration' && Object.hasOwn(migrationStages, stage)
        ? stage === 'provisioning' && data.bytes?.transferred > 0 ? 2 : migrationStages[stage] : -1;
    const measured = Number.isFinite(data.bytes?.transferred) && data.bytes.transferred >= 0
        && Number.isFinite(data.bytes?.total) && data.bytes.total >= 0;
    const transfer = current === 2 ? {
        bytes: measured ? `${formatBytes(data.bytes.transferred)} of ${formatBytes(data.bytes.total)}` : 'Not measured',
        percent: measured && Number.isFinite(data.percent) && data.percent >= 0 && data.percent <= 100 ? data.percent : null,
        eta: measured && Number.isFinite(data.etaSeconds) && data.etaSeconds >= 0
            ? data.etaSeconds < 60 ? 'Less than a minute left' : `About ${Math.ceil(data.etaSeconds / 60)} min left` : '',
    } : null;
    const duration = Number.isFinite(data.typicalSeconds) && data.typicalSeconds > 0
        ? `This usually takes about ${Math.ceil(data.typicalSeconds / 60)} minutes` : 'This can take a few minutes';
    const hardware = data.selectedNextOpenHardware;
    const next = hardware?.effective === 'next_open' && Number.isSafeInteger(hardware.vcpu) && hardware.vcpu > 0
        && Number.isFinite(hardware.memoryGiB) && hardware.memoryGiB > 0
        ? `Next session: ${hardware.vcpu} vCPU · ${hardware.memoryGiB} GiB memory. Applies after you stop this session and start again.` : '';
    return {
        stage, title: current >= 0 ? migrationSteps[current] : stages[stage][0],
        body: current === 2 && stage === 'provisioning' ? 'Your saved files are being transferred to your AWS computer.' : stages[stage][1],
        manualAttention: data.recordedStage === 'failed_needs_operator' || data.stage === 'failed_needs_operator',
        active: data.active === true && !['operations_paused', 'needs_operator', 'queued', 'unavailable', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        steps: current >= 0 ? migrationSteps.map((label, i) => ({ label, state: i < current ? 'complete' : i === current ? 'current' : 'pending' })) : [],
        transfer,
        // Only a running move may promise the files keep moving; a paused or waiting one says so honestly.
        guidance: data.operation !== 'migration' ? ''
            : ['operations_paused', 'needs_operator', 'queued'].includes(stage)
                ? data.durable === true && data.resumePolicy === 'saved_workspace_only'
                    ? 'You can reopen this view to check the saved migration. Unsaved changes inside apps are not guaranteed. Progress resumes only when operations allow it.' : ''
                : current >= 0 ? `Moving your files to AWS. ${duration}. You can close this window — your files keep moving, and your computer will be ready when you come back.` : '',
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
