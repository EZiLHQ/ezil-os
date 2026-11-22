'use client';

import { useState } from 'react';

type Phase =
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'pending'; reason: string }
    | { kind: 'failed'; message: string };

const PENDING_COPY: Record<string, string> = {
    repository_not_empty: 'Your repository already has content that is not this assignment\'s starting files, so it was not linked. Contact the assignment owner.',
    repository_unreadable: 'Your repository was created but could not be checked yet. Try again in a moment.',
};

/** The explicit consent step. Nothing is sent until the person presses the button. */
export function EnrollmentConsent({ attemptId }: { attemptId: string }) {
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const enroll = async () => {
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
            window.location.assign(body.codeUrl);
            return;
        }
        if (response.status === 202 && body?.status === 'pending') {
            setPhase({ kind: 'pending', reason: PENDING_COPY[body.reason ?? ''] ?? 'Your repository is not ready yet.' });
            return;
        }
        if (body?.error?.code === 'IDENTITY_REFRESH_REQUIRED') {
            // One silent EZiL ID round trip, as Code does; the person presses the button again on return.
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
    };
    return (
        <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
            <h1 style={{ fontSize: 24 }}>Create your assignment repository</h1>
            <p>
                EZiL will create one new private repository for this assignment, owned by your EZiL ID, add its starting
                files (an assignment marker and a README), and link it to your assignment attempt. EZiL Code then records
                disclosed assignment activity and shows recording status while you work.
            </p>
            <p style={{ color: '#555', fontSize: 14 }}>Attempt {attemptId}</p>
            <button type="button" onClick={enroll} disabled={phase.kind === 'working'}
                style={{ padding: '10px 18px', fontSize: 16, cursor: phase.kind === 'working' ? 'wait' : 'pointer' }}>
                {phase.kind === 'working' ? 'Setting up…' : 'Create repository and start'}
            </button>
            {phase.kind === 'pending' && <p role="status">{phase.reason}</p>}
            {phase.kind === 'failed' && <p role="alert">{phase.message}</p>}
        </main>
    );
}
