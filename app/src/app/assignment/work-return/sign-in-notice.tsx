'use client';

import { useEffect } from 'react';
import { listenForWorkSignIn } from '@/utils/assignment-work-auth';

export function AssignmentSignInNotice({ attemptId }: { attemptId: string }) {
    useEffect(() => listenForWorkSignIn(attemptId, window), [attemptId]);
    return <p role="status">Continue to EZiL OS sign-in from your Universe assignment tab.</p>;
}
