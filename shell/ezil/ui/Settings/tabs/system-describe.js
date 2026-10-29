// tabs/system-describe.js — EZiL-authored. Not Puter code.
//
// Pure wording for Settings → System: no DOM, no network, so every claim the
// tab makes is unit-tested (system-describe-test.mjs). Every function returns
// either a statement backed by data it was handed, or says the thing is not
// known. None of them guesses.

/** ICE candidate types that are not a relay (RTCIceCandidateType). */
const DIRECT_TYPES = new Set(['host', 'srflx', 'prflx']);

/** Older than three publish intervals: the streamed client has stopped talking. */
export const VITALS_STALE_MS = 6500;

const MIB_PER_GIB = 1024;

/**
 * The provider row. `info` is `computer.systemInfo`'s answer, or null when it
 * could not be read (`reason` says why).
 *
 * @returns {{ value: string, hint: string }}
 */
export function describeProvider (info, reason) {
    if ( ! info ) {
        return {
            value: 'Unknown',
            hint: reason === 'UNSUPPORTED'
                ? 'This deployment cannot report it yet.'
                : 'Could not read where this computer runs right now.',
        };
    }
    switch ( info.provider ) {
    case 'aws-ec2': {
        // Round 4 copy guard: "AWS (India)", never a region code or a city.
        const region = info.machine && info.machine.region;
        return {
            value: region === 'ap-south-1' ? 'AWS (India)' : region ? `AWS (${region})` : 'AWS',
            hint: info.lifecycleState ? `Recorded placement. State: ${String(info.lifecycleState).toLowerCase()}.` : 'Recorded placement.',
        };
    }
    case 'cloudflare':
        return { value: 'Cloudflare Containers', hint: 'Recorded placement.' };
    case 'unassigned':
        return { value: 'Not assigned yet', hint: 'Nothing has recorded where this computer runs; its next start decides.' };
    default:
        if ( info.providerSource === 'reads_off' ) {
            return {
                value: 'Unknown',
                hint: info.configuredRouting === 'cloudflare'
                    ? 'Not recorded in this deployment. Routing is configured to start computers on Cloudflare Containers; where this one runs is not verified.'
                    : 'Not recorded in this deployment.',
            };
        }
        return { value: 'Unknown', hint: 'The placement could not be read.' };
    }
}

/** The image row: only a reported running image, never a configured default.
 * @returns {{ value: string, title: string }}
 */
export function describeImage (info) {
    const image = info && info.image;
    if ( image && image.source === 'running' && typeof image.id === 'string' && image.id ) {
        return { value: image.id.slice(0, 12), title: image.id };
    }
    return { value: 'Not reported yet', title: '' };
}

/**
 * The machine row: the CONFIGURED size of the recorded machine, never a
 * measurement and never inferred from the user's plan.
 *
 * @returns {{ value: string, hint: string }}
 */
export function describeMachine (info) {
    const m = info && info.machine;
    if ( ! m ) return { value: '—', hint: 'Not known.' };
    const parts = [];
    if ( Number.isFinite(m.vcpu) ) parts.push(`${m.vcpu} vCPU`);
    if ( Number.isFinite(m.memoryMiB) ) {
        const gib = m.memoryMiB / MIB_PER_GIB;
        parts.push(`${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB RAM`);
    }
    const size = parts.join(' · ');
    if ( m.instanceType ) {
        return {
            value: size ? `${size} (${m.instanceType})` : String(m.instanceType),
            hint: size ? 'Configured size of the recorded instance type, not a live measurement.' : 'Size of this instance type is not known here.',
        };
    }
    if ( size && m.source === 'configured' ) {
        return { value: size, hint: 'Configured container size, not a live measurement.' };
    }
    return { value: '—', hint: 'Not known until a provider is recorded.' };
}

/** CPU and memory USE: nothing measures it yet, and the tab must say so. */
export function describeUsage () {
    return { value: 'Not measured', hint: 'Live CPU and memory use is not reported by the computer yet.' };
}

/**
 * The transport row, from the SELECTED candidate pair the streamed client
 * measured (`localCandidateType`, `remoteCandidateType`, `relayProtocol`).
 * "Relayed through TURN" only when a side of the selected pair is `relay`.
 *
 * @param {object|null} v       the latest vitals, or null
 * @param {number}      ageMs   how old they are
 * @param {string|null} provider  'cloudflare' | 'aws-ec2' | other
 * @returns {{ value: string, hint: string }}
 */
export function describeTransport (v, ageMs, provider) {
    if ( ! v || ! Number.isFinite(ageMs) || ageMs > VITALS_STALE_MS ) {
        return { value: '—', hint: 'Not measured right now.' };
    }
    const local = typeof v.localCandidateType === 'string' ? v.localCandidateType : null;
    const remote = typeof v.remoteCandidateType === 'string' ? v.remoteCandidateType : null;
    if ( ! local && ! remote ) {
        return { value: '—', hint: 'The connection has not reported its route yet.' };
    }
    if ( local === 'relay' || remote === 'relay' ) {
        const proto = typeof v.relayProtocol === 'string' && v.relayProtocol ? ` over ${v.relayProtocol.toUpperCase()}` : '';
        return {
            value: `Relayed through TURN${proto}`,
            hint: provider === 'cloudflare'
                ? 'Cloudflare Containers have no inbound UDP, so the stream is relayed; that sets a floor on the round trip.'
                : 'The stream goes through a relay server, which adds to the round trip.',
        };
    }
    // "Direct" needs BOTH sides known and recognised as non-relay. One side missing, or a type
    // this code does not know, is an incomplete observation: say unknown rather than guess.
    if ( ! DIRECT_TYPES.has(local) || ! DIRECT_TYPES.has(remote) ) {
        return { value: '—', hint: 'The connection reported an incomplete route, so whether it is relayed is not known.' };
    }
    return { value: `Direct (${local} → ${remote})`, hint: 'No relay on the selected route.' };
}

/**
 * Why the desktop screen could not be read, from the server's error code and
 * message. Only a fixed set of known reason tokens is ever shown; anything else
 * collapses to the code, so no raw upstream text reaches the page.
 */
const SCREEN_REASONS = [
    [/^screen_starting\b|^aws_origin_starting\b/, 'the desktop is still starting'],
    [/^aws_origin_unavailable\b/, "the computer's connection to the desktop service is not up"],
    [/^screen_login_failed/, 'the desktop refused the stream login'],
    [/^screen_unreadable\b/, 'the desktop did not report its screen'],
    [/^screen_upstream_exception\b/, 'the desktop service hit an error'],
    [/^provider_not_configured\b/, 'the desktop service is not configured in this deployment'],
    [/^screen read timed out\b/, 'the desktop did not answer in time'],
    [/^worker_http_(\d{3})\b/, null],
];

export function describeScreenError (code, message) {
    const msg = typeof message === 'string' ? message.trim().toLowerCase() : '';
    for ( const [re, text] of SCREEN_REASONS ) {
        const m = msg.match(re);
        if ( ! m ) continue;
        return text ?? `the desktop service answered HTTP ${m[1]}`;
    }
    if ( typeof code === 'string' && code ) return code.toLowerCase().replace(/_/g, ' ');
    return 'unavailable';
}

/**
 * Actual placement and plan entitlement are independent claims. Round 4: one line,
 * "AWS (India) · 2 vCPU / 8 GiB · stopped" (data-role sys-running-on).
 */
export function describeRunningOn (info, reason) {
    const provider = describeProvider(info, reason);
    const m = info && info.machine;
    const size = m && Number.isFinite(m.vcpu) && Number.isFinite(m.memoryMiB) ? `${m.vcpu} vCPU / ${m.memoryMiB / 1024} GiB` : '';
    const state = info && info.provider === 'aws-ec2' && typeof info.lifecycleState === 'string' && info.lifecycleState
        ? info.lifecycleState.toLowerCase() : '';
    return { value: [provider.value, size, state].filter(Boolean).join(' · '), hint: state ? 'Recorded placement.' : provider.hint };
}

const STANDINGS = new Set(['paid', 'grace', 'plan_ending', 'files_on_aws', 'free']);

/**
 * Round 4: the server's standing for this computer (STANDING-CONTRACT), read only from
 * explicit fields — `info.plan.standing` or `info.standing`. Null when not reported.
 */
export function standingOf (info) {
    const value = info && (info.plan && info.plan.standing !== undefined ? info.plan.standing : info.standing);
    return STANDINGS.has(value) ? value : null;
}

const SIZE_LABEL = { 'std-2': '2 vCPU / 8 GB', 'cmp-4': '4 vCPU / 16 GB', 'cmp-8': '8 vCPU / 32 GB' };

/**
 * The plan row (round 3, SWITCH-CONTRACT §4). `plan.status` comes from the
 * server: `being_prepared` ONLY while a switch or restart is in flight;
 * `ready` once the computer is on AWS, whatever the next-start choice is (a
 * plain size mismatch is no longer "being prepared"); `failed` for a failed
 * switch or migration; `preparing` before the computer reaches AWS; `blocked`
 * while AWS is paused. The running size and the next-start choice are told
 * apart, never mixed in one value.
 */
export function describePlan (info) {
    const p = info && info.plan;
    // Round 4: Free is told only from an explicit server field (a standing, sku or status), never
    // from a missing plan. Files on the AWS computer are kept there; nothing is said to have moved.
    const standing = standingOf(info);
    const free = standing === 'files_on_aws' || standing === 'free' || (p && (p.sku === 'free_v3' || p.status === 'free'));
    if ( free ) {
        const onAws = standing === 'files_on_aws' || (p && p.filesOn === 'aws') || (info && info.filesOn === 'aws');
        if ( onAws ) return { value: 'Plan: Free · files kept on this computer', hint: 'It opens with Free limits. Upgrade to restore full use.' };
        const size = p && Number.isFinite(p.vcpu) && Number.isFinite(p.memoryGB) ? ` · ${p.vcpu} vCPU / ${p.memoryGB} GB on Cloudflare` : '';
        return { value: `Plan: Free${size}`, hint: '' };
    }
    if ( ! p ) return { value: 'Not reported', hint: 'Plan entitlement is not available.' };
    const planned = `${p.vcpu} vCPU / ${p.memoryGB} GB on AWS (India)`;
    const current = SIZE_LABEL[p.current] ?? null;
    const selected = SIZE_LABEL[p.selected] ?? null;
    const t = p.transition && typeof p.transition === 'object' ? p.transition : null;
    switch ( p.status ) {
    case 'being_prepared':
        if ( t && t.kind === 'restart' ) return { value: 'Restarting your computer', hint: current ? `Running on ${current} until it restarts.` : '' };
        return { value: t && SIZE_LABEL[t.target] ? `Switching to ${SIZE_LABEL[t.target]}` : `${planned} — being prepared`,
            hint: t && SIZE_LABEL[t.current] ? `Now: ${SIZE_LABEL[t.current]}.` : '' };
    case 'ready':
        return { value: current ? `${current} on AWS (India)` : planned,
            hint: selected && current && selected !== current ? `Next start: ${selected}.` : '' };
    case 'failed':
        if ( t && SIZE_LABEL[t.current] ) return { value: `Switch didn't finish — back on ${SIZE_LABEL[t.current]}`, hint: 'Your files are safe. Try again from Settings → Computer.' };
        return { value: `${planned} — preparation failed`, hint: p.reason || '' };
    case 'blocked':
        return { value: `${planned} — paused`, hint: p.reason || '' };
    case 'preparing':
        return { value: `${planned} — being prepared`, hint: p.reason || '' };
    default:
        return { value: `${planned} — status unknown`, hint: p.reason || '' };
    }
}
