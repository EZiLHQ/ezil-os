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
    case 'aws-ec2':
        return {
            value: info.machine && info.machine.region ? `AWS EC2 (${info.machine.region})` : 'AWS EC2',
            hint: info.lifecycleState ? `Recorded placement. State: ${String(info.lifecycleState).toLowerCase()}.` : 'Recorded placement.',
        };
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

/** Actual placement and plan entitlement are independent claims. */
export function describeRunningOn (info, reason) {
    const provider = describeProvider(info, reason);
    const m = info && info.machine;
    const size = m && Number.isFinite(m.vcpu) && Number.isFinite(m.memoryMiB)
        ? ` (${m.vcpu} vCPU / ${m.memoryMiB / 1024} GiB)` : '';
    return { value: provider.value + size, hint: provider.hint };
}

export function describePlan (info) {
    const p = info && info.plan;
    if ( ! p ) return { value: 'Not reported', hint: 'Plan entitlement is not available.' };
    const status = { preparing: 'being prepared', blocked: 'paused', failed: 'preparation failed', ready: 'ready' }[p.status] || 'status unknown';
    return { value: `${p.vcpu} vCPU / ${p.memoryGB} GB in Mumbai — ${status}`, hint: p.reason || '' };
}
