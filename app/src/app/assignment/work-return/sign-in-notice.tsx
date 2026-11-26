'use client';

import { useEffect, useState } from 'react';

import { silentWorkSignIn, type SilentPhase } from './silent-sign-in';

/**
 * The few words of the framed sign-in document. Neutral on purpose: the first is what the server renders before
 * anything is known, and none tells the person where to go. The Universe tab around this frame owns the action.
 */
export const SIGN_IN_NOTICE = { opening: 'Opening Code…', checking: 'Checking your EZiL ID…', required: 'Sign in to continue' } as const;

export function AssignmentSignInNotice({ attemptId }: { attemptId: string }) {
    const [phase, setPhase] = useState<'opening' | SilentPhase>('opening');
    useEffect(() => silentWorkSignIn(attemptId, window, setPhase), [attemptId]);
    return <p role="status">{SIGN_IN_NOTICE[phase]}</p>;
}
