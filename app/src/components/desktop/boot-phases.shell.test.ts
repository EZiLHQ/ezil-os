/**
 * Tests for the shell's copy of the boot-phase logic
 * (`./boot-phases.shell.js`, bound for `shell/ezil/boot-phases.js`).
 *
 * The first four `describe` blocks are the original suite from
 * `./boot-phases.test.ts`, re-pointed at the JS module — they travel with it.
 * The final block does NOT travel: it is the drift guard, and it only works
 * while both copies live in the same tree. Drop it when the module moves.
 */

import { describe, expect, it } from 'vitest';

import * as original from './boot-phases';
import {
    BOOT_FAILURE_COPY,
    BOOT_PHASES,
    BOOT_UNVERIFIED_COPY,
    LONG_BOOT_MS,
    TYPICAL_BOOT_MS,
    applyDisplayEvidence,
    classifyPreviewFetchError,
    computeBootUiState,
    estimatePhaseForElapsedMs,
    phaseVisualState,
} from './boot-phases.shell.js';
import * as ported from './boot-phases.shell.js';

type BootProgressState = original.BootProgressState;

describe('estimatePhaseForElapsedMs', () => {
    it('starts at "waking" immediately', () => {
        expect(estimatePhaseForElapsedMs(0)).toBe('waking');
        expect(estimatePhaseForElapsedMs(299)).toBe('waking');
    });

    it('moves to "mounting" once container_start elapses (~0.3s)', () => {
        expect(estimatePhaseForElapsedMs(300)).toBe('mounting');
        expect(estimatePhaseForElapsedMs(3_000)).toBe('mounting');
    });

    it('moves to "starting" once workspace_mount elapses (~6.2s cumulative)', () => {
        expect(estimatePhaseForElapsedMs(6_200)).toBe('starting');
        expect(estimatePhaseForElapsedMs(15_000)).toBe('starting');
    });

    it('moves to "connecting" once desktop_ready_wait elapses (~21.5s cumulative)', () => {
        expect(estimatePhaseForElapsedMs(21_500)).toBe('connecting');
        expect(estimatePhaseForElapsedMs(60_000)).toBe('connecting');
    });

    it('TYPICAL_BOOT_MS matches the measured reference total from PLATFORM-NOTES §11', () => {
        // container_start (0.3s) + workspace_mount (5.9s) + desktop_ready_wait (15.3s) = 21.5s
        expect(TYPICAL_BOOT_MS).toBe(21_500);
    });
});

describe('computeBootUiState — never fabricates progress', () => {
    it('reports not_configured distinctly from a failure', () => {
        const state = computeBootUiState({ requestStatus: 'not_configured', elapsedMs: 0 });
        expect(state.kind).toBe('not_configured');
    });

    it('reports ready only once the preview request resolved ok AND the frame was confirmed', () => {
        const state = computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 999,
            frameConfirmed: true,
        });
        expect(state).toEqual({ kind: 'ready' });
    });

    // 🔴 THE REGRESSION GUARD FOR THE HANDOFF BLIND SPOT.
    // `success` means the Worker handed back a URL. On 2026-07-31 that URL
    // served HTTP 500 "Proxy routing error" and both surfaces reported success
    // over it, because this branch used to return `ready` unconditionally. It
    // must now be impossible to reach `ready` without a positive observation of
    // the desktop origin itself.
    it('CANNOT report ready on a successful request whose frame was refuted', () => {
        expect(
            computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: false }),
        ).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
    });

    it('CANNOT report ready when nobody looked at the frame at all — fails closed', () => {
        // A caller that forgot to thread the observation gets a visible,
        // retryable failure, never an unearned `ready`.
        expect(computeBootUiState({ requestStatus: 'success', elapsedMs: 0 })).toEqual({
            kind: 'failed',
            reason: 'desktop_unreachable',
        });
    });

    it('accepts nothing but a literal `true` as a frame confirmation', () => {
        for (const junk of [1, 'true', 'yes', {}, [], 'ok'] as unknown[]) {
            expect(
                computeBootUiState({
                    requestStatus: 'success',
                    elapsedMs: 0,
                    frameConfirmed: junk as boolean,
                }),
            ).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
        }
    });

    it('maps a server-reported desktop_unreachable error code to its own copy, not to "unknown"', () => {
        expect(
            computeBootUiState({
                requestStatus: 'error',
                elapsedMs: 0,
                errorCode: 'desktop_unreachable',
            }),
        ).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
    });

    it('while pending, never marks a phase confirmed from elapsed time alone', () => {
        const state = computeBootUiState({ requestStatus: 'pending', elapsedMs: 25_000 });
        expect(state.kind).toBe('progress');
        const progress = state as BootProgressState;
        expect(progress.confirmed).toBe(false);
        // Estimate has run past the typical total, so it settles on the last phase —
        // but "on the last phase" and "confirmed" are not the same claim.
        expect(progress.currentPhase).toBe('connecting');
    });

    it('treats an undefined status poll as "no information", not as guacamoleRunning: false', () => {
        const withUndefined = computeBootUiState({ requestStatus: 'pending', elapsedMs: 1_000 });
        const withExplicitFalse = computeBootUiState({
            requestStatus: 'pending',
            elapsedMs: 1_000,
            confirmedGuacamoleRunning: false,
        });
        // Both fall back to the time estimate — the point is only that a
        // present-but-false observation must not be treated any more
        // confidently than absence of an observation.
        expect(withUndefined).toEqual(withExplicitFalse);
    });

    it('upgrades to a confirmed "connecting" phase the instant guacamoleRunning is genuinely observed, even ahead of the timer', () => {
        const state = computeBootUiState({
            requestStatus: 'pending',
            elapsedMs: 2_000, // timer alone would still say "mounting"
            confirmedGuacamoleRunning: true,
        });
        expect(state).toEqual({
            kind: 'progress',
            currentPhase: 'connecting',
            confirmed: true,
            isRunningLong: false,
        });
    });

    it('flags a long-running boot past LONG_BOOT_MS without claiming anything is wrong', () => {
        const state = computeBootUiState({ requestStatus: 'pending', elapsedMs: LONG_BOOT_MS });
        expect(state.kind).toBe('progress');
        expect((state as BootProgressState).isRunningLong).toBe(true);
    });

    it('maps genuine Worker error codes to plain-language failure reasons', () => {
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'connection_refused' })).toEqual({
            kind: 'failed',
            reason: 'worker_unreachable',
        });
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'fetch_failed' })).toEqual({
            kind: 'failed',
            reason: 'worker_unreachable',
        });
        expect(
            computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'sandbox_runtime_blocked' }),
        ).toEqual({ kind: 'failed', reason: 'sandbox_crashed' });
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'sandbox_start_failed' })).toEqual({
            kind: 'failed',
            reason: 'sandbox_crashed',
        });
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'timeout' })).toEqual({
            kind: 'failed',
            reason: 'timeout',
        });
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'worker_http_error' })).toEqual({
            kind: 'failed',
            reason: 'unknown',
        });
        expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0 })).toEqual({
            kind: 'failed',
            reason: 'unknown',
        });
    });

    it('gives the deterministic family the generic copy, never "retrying usually fixes this"', () => {
        // These four are our bug or our misconfiguration and cannot be
        // retried away, so `sandbox_crashed` — whose copy promises a retry
        // will help — would be a lie. They take `unknown`, whose "if it keeps
        // happening, let us know" is the true thing to say.
        for (const errorCode of [
            'bad_request',
            'unauthorized',
            'preconditions_unmet',
            'custom_domain_required',
        ] as const) {
            expect(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode })).toEqual({
                kind: 'failed',
                reason: 'unknown',
            });
        }
    });

    it('invents no new failure copy for them — every reason still resolves to existing strings', () => {
        expect(Object.keys(BOOT_FAILURE_COPY).sort()).toEqual([
            // 🔴 `display_not_streaming` is reachable ONLY through
            // `applyDisplayEvidence`. It is deliberately absent from
            // `classifyFailure`'s switch and from `BootErrorCode`, because the
            // preview request cannot fail this way — the request succeeds and
            // then no picture arrives. The sweep above proves the deterministic
            // error codes still land on `unknown` rather than reaching for it.
            'desktop_unreachable',
            'display_not_streaming',
            'sandbox_crashed',
            'timeout',
            'unknown',
            'worker_unreachable',
        ]);
    });
});

// ─── The SECOND gate ────────────────────────────────────────────────────────
// `computeBootUiState` above answers "is there a desktop at that URL". This
// answers "did any of it reach the browser", and it is a separate function on
// purpose — see its doc comment. The property that matters is not that `live`
// works; it is that NOTHING ELSE DOES.

describe('applyDisplayEvidence — only literal "live" survives as ready', () => {
    const READY = { kind: 'ready' } as const;

    it('lets a confirmed streaming display through', () => {
        expect(applyDisplayEvidence(READY, 'live')).toEqual({ kind: 'ready' });
    });

    it('🔴 turns an observed-blank display into an honest, retryable failure', () => {
        expect(applyDisplayEvidence(READY, 'blank')).toEqual({
            kind: 'failed',
            reason: 'display_not_streaming',
        });
    });

    it('🔴 turns "we could not tell" into ready_unverified — never ready, never failed', () => {
        expect(applyDisplayEvidence(READY, 'unknown')).toEqual({ kind: 'ready_unverified' });
    });

    it('🔴 treats a caller that never threaded the evidence as not having checked', () => {
        // The omission loophole. If this returned `ready`, deleting one
        // argument at a call site would silently restore the original defect,
        // and nothing would fail.
        expect(applyDisplayEvidence(READY, undefined)).toEqual({ kind: 'ready_unverified' });
    });

    it('🔴 accepts nothing truthy off the wire as a stand-in for the observation', () => {
        // Same rule as `frameConfirmed === true` in `computeBootUiState`: a
        // body that says something we did not plan for is exactly what
        // `unknown` exists to catch, and it must not be able to open the gate.
        for (const junk of [true, 1, 'LIVE', 'Live', ' live', 'live ', 'watching', {}, [], null, NaN]) {
            expect(applyDisplayEvidence(READY, junk as never)).toEqual({ kind: 'ready_unverified' });
        }
    });

    it('🔴 only ever DOWNGRADES — pixel evidence cannot rescue a failed boot', () => {
        const failed = { kind: 'failed', reason: 'sandbox_crashed' } as const;
        const progress = { kind: 'progress', currentPhase: 'starting', confirmed: false, isRunningLong: false } as const;
        const notConfigured = { kind: 'not_configured' } as const;
        for (const evidence of ['live', 'blank', 'unknown', undefined] as const) {
            expect(applyDisplayEvidence(failed, evidence)).toBe(failed);
            expect(applyDisplayEvidence(progress, evidence)).toBe(progress);
            expect(applyDisplayEvidence(notConfigured, evidence)).toBe(notConfigured);
        }
    });

    it('🔴 the whole desktop chain: a reachable origin with no viewer is not ready', () => {
        // Composed exactly as `settle_display` composes it, so this pins the
        // real pipeline rather than a restatement of it.
        const frameState = computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: true });
        expect(frameState).toEqual({ kind: 'ready' });
        expect(applyDisplayEvidence(frameState, 'blank')).toEqual({
            kind: 'failed',
            reason: 'display_not_streaming',
        });
        expect(applyDisplayEvidence(frameState, 'live')).toEqual({ kind: 'ready' });
    });

    it('the unverified copy names the uncertainty and never claims readiness', () => {
        expect(BOOT_UNVERIFIED_COPY.title).toBe("We couldn't check your display");
        expect(`${BOOT_UNVERIFIED_COPY.title} ${BOOT_UNVERIFIED_COPY.body}`.toLowerCase())
            .not.toContain('ready');
        expect(BOOT_UNVERIFIED_COPY.body).toContain('try again');
    });

    it('the streaming-failure copy blames the route, not the user or the machine', () => {
        const copy = BOOT_FAILURE_COPY.display_not_streaming;
        expect(copy.title).toBe("Your desktop isn't coming through");
        // It must not tell the user their computer failed — it did not.
        expect(copy.body).toContain('Your computer is running');
        expect(copy.body).toContain('try again');
    });
});

describe('phaseVisualState — only "confirmed" is a real observation', () => {
    const estimatedProgress: BootProgressState = {
        kind: 'progress',
        currentPhase: 'starting',
        confirmed: false,
        isRunningLong: false,
    };

    it('marks earlier phases "passed" (estimated-complete), not confirmed', () => {
        expect(phaseVisualState('waking', estimatedProgress)).toBe('passed');
        expect(phaseVisualState('mounting', estimatedProgress)).toBe('passed');
    });

    it('marks the active phase "current" when not backed by a real signal', () => {
        expect(phaseVisualState('starting', estimatedProgress)).toBe('current');
    });

    it('marks later phases "upcoming"', () => {
        expect(phaseVisualState('connecting', estimatedProgress)).toBe('upcoming');
    });

    it('marks the active phase "confirmed" only when progress.confirmed is true', () => {
        const confirmedProgress: BootProgressState = {
            kind: 'progress',
            currentPhase: 'connecting',
            confirmed: true,
            isRunningLong: false,
        };
        expect(phaseVisualState('connecting', confirmedProgress)).toBe('confirmed');
        // Every phase before it is still just an estimate, not a checkmark.
        expect(phaseVisualState('starting', confirmedProgress)).toBe('passed');
    });

    it('covers every phase in BOOT_PHASES', () => {
        expect(BOOT_PHASES.map((p) => p.id)).toEqual(['waking', 'mounting', 'starting', 'connecting']);
    });
});

describe('classifyPreviewFetchError — only a real AbortSignal.timeout counts as "timeout"', () => {
    it('classifies a DOMException named TimeoutError (what AbortSignal.timeout actually throws)', () => {
        const err = Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
        });
        expect(classifyPreviewFetchError(err)).toBe('timeout');
    });

    it('does not classify an unrelated error as a timeout', () => {
        expect(classifyPreviewFetchError(new Error('ECONNREFUSED'))).toBeUndefined();
        expect(classifyPreviewFetchError('not an error')).toBeUndefined();
        expect(classifyPreviewFetchError(undefined)).toBeUndefined();
    });
});

// ─── DRIFT GUARD — does not travel to `shell/` ──────────────────────────────
//
// The port was a module-format conversion, and this is what keeps that claim
// true. It compares the two copies input by input rather than reading them:
// a "small improvement" made to one and not the other fails here, which is
// the failure mode that matters, because the two copies are read by different
// people at different times and the honesty rules live in the branches.

describe('the port is a module-format conversion and nothing more', () => {
    const ELAPSED_SWEEP = [0, 1, 299, 300, 3_000, 6_199, 6_200, 21_499, 21_500, 34_999, 35_000, 120_000];
    const REQUEST_STATUSES = ['not_configured', 'pending', 'success', 'error'] as const;
    const CONFIRMED = [undefined, false, true] as const;
    const ERROR_CODES = [
        undefined,
        'bad_request',
        'unauthorized',
        'preconditions_unmet',
        'custom_domain_required',
        'connection_refused',
        'fetch_failed',
        'sandbox_runtime_blocked',
        'sandbox_start_failed',
        'worker_http_error',
        'desktop_unreachable',
        'timeout',
        'unknown',
    ] as const;
    // The handoff observation. `undefined` is in the sweep on purpose: "nobody
    // looked" is a distinct input from "looked and saw nothing", and the two
    // copies must agree that neither is a `ready`.
    const FRAME_CONFIRMED = [undefined, false, true] as const;

    it('exports exactly the same names', () => {
        expect(Object.keys(ported).sort()).toEqual(Object.keys(original).sort());
    });

    it('agrees on every constant and every user-facing string', () => {
        expect(ported.BOOT_PHASES).toEqual(original.BOOT_PHASES);
        expect(ported.TYPICAL_BOOT_MS).toBe(original.TYPICAL_BOOT_MS);
        expect(ported.LONG_BOOT_MS).toBe(original.LONG_BOOT_MS);
        expect(ported.BOOT_PROGRESS_HEADLINE).toBe(original.BOOT_PROGRESS_HEADLINE);
        expect(ported.BOOT_PROGRESS_SUBTEXT).toBe(original.BOOT_PROGRESS_SUBTEXT);
        expect(ported.BOOT_PROGRESS_LONG_SUBTEXT).toBe(original.BOOT_PROGRESS_LONG_SUBTEXT);
        expect(ported.BOOT_FAILURE_COPY).toEqual(original.BOOT_FAILURE_COPY);
        expect(ported.BOOT_NOT_CONFIGURED_COPY).toEqual(original.BOOT_NOT_CONFIGURED_COPY);
        expect(ported.BOOT_UNVERIFIED_COPY).toEqual(original.BOOT_UNVERIFIED_COPY);
    });

    it('agrees on estimatePhaseForElapsedMs across the whole timeline', () => {
        for (const elapsedMs of ELAPSED_SWEEP) {
            expect(ported.estimatePhaseForElapsedMs(elapsedMs)).toBe(
                original.estimatePhaseForElapsedMs(elapsedMs),
            );
        }
    });

    it('agrees on computeBootUiState for every combination of inputs', () => {
        let compared = 0;
        for (const requestStatus of REQUEST_STATUSES) {
            for (const elapsedMs of ELAPSED_SWEEP) {
                for (const confirmedGuacamoleRunning of CONFIRMED) {
                    for (const errorCode of ERROR_CODES) {
                        for (const frameConfirmed of FRAME_CONFIRMED) {
                            const input = {
                                requestStatus,
                                elapsedMs,
                                confirmedGuacamoleRunning,
                                errorCode,
                                frameConfirmed,
                            };
                            expect(ported.computeBootUiState(input)).toEqual(
                                original.computeBootUiState(input),
                            );
                            compared++;
                        }
                    }
                }
            }
        }
        // Guards against the sweep silently collapsing to nothing.
        expect(compared).toBe(
            REQUEST_STATUSES.length *
                ELAPSED_SWEEP.length *
                CONFIRMED.length *
                ERROR_CODES.length *
                FRAME_CONFIRMED.length,
        );
    });

    it('agrees on phaseVisualState for every phase against every progress state', () => {
        for (const phase of original.BOOT_PHASES) {
            for (const current of original.BOOT_PHASES) {
                for (const confirmed of [false, true]) {
                    const progress: BootProgressState = {
                        kind: 'progress',
                        currentPhase: current.id,
                        confirmed,
                        isRunningLong: false,
                    };
                    expect(ported.phaseVisualState(phase.id, progress)).toBe(
                        original.phaseVisualState(phase.id, progress),
                    );
                }
            }
        }
    });

    it('agrees on applyDisplayEvidence for every state against every answer', () => {
        // 🔴 The junk values are the point. The two copies must agree not only
        // that `'live'` passes, but that every near-miss for it does NOT —
        // that is the whole safety property, and it is exactly the kind of
        // thing a "small improvement" to one copy would quietly relax.
        const BASE_STATES: unknown[] = [
            { kind: 'ready' },
            { kind: 'ready_unverified' },
            { kind: 'not_configured' },
            { kind: 'failed', reason: 'desktop_unreachable' },
            { kind: 'failed', reason: 'display_not_streaming' },
            { kind: 'progress', currentPhase: 'connecting', confirmed: true, isRunningLong: false },
            { kind: 'progress', currentPhase: 'waking', confirmed: false, isRunningLong: true },
        ];
        const ANSWERS: unknown[] = [
            'live', 'blank', 'unknown', undefined, null, true, false, 1, 0,
            'LIVE', 'Live', ' live', 'live ', 'watching', '', {}, [],
        ];
        let compared = 0;
        for (const state of BASE_STATES) {
            for (const answer of ANSWERS) {
                expect(ported.applyDisplayEvidence(state as never, answer as never)).toEqual(
                    original.applyDisplayEvidence(state as never, answer as never),
                );
                compared++;
            }
        }
        expect(compared).toBe(BASE_STATES.length * ANSWERS.length);
        // And a vacuity guard of its own: the sweep must actually contain a
        // pass, a failure and an unverified, or "they agree" means nothing.
        const kinds = new Set(
            ANSWERS.map((a) => (ported.applyDisplayEvidence({ kind: 'ready' } as never, a as never)).kind),
        );
        expect([...kinds].sort()).toEqual(['failed', 'ready', 'ready_unverified']);
    });

    it('agrees on classifyPreviewFetchError', () => {
        const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
        for (const err of [timeout, new Error('boom'), 'string', undefined, null, 42]) {
            expect(ported.classifyPreviewFetchError(err)).toBe(original.classifyPreviewFetchError(err));
        }
    });
});
