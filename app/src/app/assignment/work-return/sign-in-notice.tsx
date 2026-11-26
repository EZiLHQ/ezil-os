'use client';

import { useEffect, useState } from 'react';

import { silentWorkSignIn } from './silent-sign-in';

export function AssignmentSignInNotice({ attemptId }: { attemptId: string }) {
    const [pending, setPending] = useState(false);
    useEffect(() => silentWorkSignIn(attemptId, window, setPending), [attemptId]);
    return <p role="status">{pending ? 'Checking your EZiL OS sign-in…' : 'Continue to EZiL OS sign-in from your Universe assignment tab.'}</p>;
}
