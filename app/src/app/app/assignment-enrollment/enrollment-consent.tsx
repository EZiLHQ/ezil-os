'use client';

import { AssignmentSignInNotice } from '../../assignment/work-return/sign-in-notice';
import { useCallback, useEffect, useRef, useState } from 'react';

type Phase =
    | { kind: 'idle' }
    | { kind: 'sign-in' }
    | { kind: 'working' }
    | { kind: 'pending'; reason: string }
    | { kind: 'failed'; message: string };

const PENDING_COPY: Record<string, string> = {
    repository_not_empty: 'Your repository already has content that is not this assignment\'s starting files, so it was not linked. Contact the assignment owner.',
    repository_unreadable: 'Your repository was created but could not be checked yet. Try again in a moment.',
};

/** Resume the existing participant-owned assignment handoff. Phone and assignment consent were checked by Universe. */
export function EnrollmentConsent({ attemptId }: { attemptId: string }) {
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const started = useRef(false);
    const enroll = useCallback(async () => {
        setPhase({ kind: 'working' });
        let response: Response;
        try {
            response = await fetch('/api/shell/assignment-enrollment', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'content-type': 'application/json', 'x-ezil-assignment-enrollment': '1' },
                body: JSON.stringify({ attemptId }),
            });
        } catch {
            setPhase({ kind: 'failed', message: 'Could not reach EZiL OS. Check your connection and try again.' });
            return;
        }
        const body = await response.json().catch(() => null) as
            | { status?: string; codeUrl?: string; reason?: string; error?: { code?: string; message?: string } } | null;
        if (response.status === 200 && body?.status === 'bound' && typeof body.codeUrl === 'string' && body.codeUrl.startsWith('/app/code?')) {
            window.location.replace(body.codeUrl);
            return;
        }
        if (response.status === 202 && body?.status === 'pending') {
            setPhase({ kind: 'pending', reason: PENDING_COPY[body.reason ?? ''] ?? 'Your repository is not ready yet.' });
            return;
        }
        if ((response.status === 401 || body?.error?.code === 'IDENTITY_REFRESH_REQUIRED') && window !== window.top) {
            setPhase({kind:'sign-in'});
            return;
        }
        if (body?.error?.code === 'IDENTITY_REFRESH_REQUIRED') {
            // One silent EZiL ID round trip restores the same authenticated assignment handoff.
            const key = `ezil-assignment-enrollment-refresh:${attemptId}`;
            let asked = false;
            try { asked = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch { /* storage unavailable */ }
            if (!asked) {
                const returnUrl = `/app/assignment-enrollment?attempt=${attemptId}`;
                window.location.assign(`/auth/auth0/login?${new URLSearchParams({ prompt: 'none', returnUrl })}`);
                return;
            }
        }
        setPhase({ kind: 'failed', message: body?.error?.message ?? 'Your assignment repository could not be set up. Try again.' });
    }, [attemptId]);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void enroll();
    }, [enroll]);
    if (phase.kind === 'sign-in') return <AssignmentSignInNotice attemptId={attemptId} />;
    return (
        <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
            <h1 style={{ fontSize: 24 }}>Opening your assignment</h1>
            {(phase.kind === 'working' || phase.kind === 'idle') && <p role="status">Preparing your private repository…</p>}
            {(phase.kind === 'pending' || phase.kind === 'failed') && <button type="button" onClick={enroll}>Try again</button>}
            {phase.kind === 'pending' && <p role="status">{phase.reason}</p>}
            {phase.kind === 'failed' && <p role="alert">{phase.message}</p>}
        </main>
    );
}
