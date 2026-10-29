/**
 * Per-user shell feature switches — the ONLY reader of the Feedback env flags
 * (`docs/FEEDBACK-CONTROLS-CONTRACT.md` §1). The floating-controls pill is not
 * part of this build (round 3 ports Feedback only), so `floatingControls` is
 * always false and no env key can turn it on.
 *
 * Pure over an explicit env object so tests never touch `@/env`'s eager
 * validation. Every flag is OFF unless set to exactly '1'; a pilot list, when
 * set, narrows Feedback to those emails (case-insensitive) and fails closed for
 * a caller with no email.
 */

export interface ShellFeatureEnv {
    EZIL_OS_FEEDBACK?: string;
    EZIL_OS_FEEDBACK_SCREENSHOTS?: string;
    FEEDBACK_PILOT_EMAILS?: string;
}

export interface ShellFeatures {
    floatingControls: boolean;
    feedback: boolean;
    feedbackScreenshots: boolean;
}

export const NO_SHELL_FEATURES: ShellFeatures = Object.freeze({
    floatingControls: false,
    feedback: false,
    feedbackScreenshots: false,
});

function onList(email: string | null | undefined, list: string): boolean {
    const target = email?.trim().toLowerCase();
    if (!target) return false;
    return list
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .includes(target);
}

export function shellFeaturesFor(email: string | null | undefined, envIn: ShellFeatureEnv): ShellFeatures {
    const pilot = envIn.FEEDBACK_PILOT_EMAILS?.trim();
    const feedback = envIn.EZIL_OS_FEEDBACK === '1' && (!pilot || onList(email, pilot));
    return {
        floatingControls: false,
        feedback,
        feedbackScreenshots: feedback && envIn.EZIL_OS_FEEDBACK_SCREENSHOTS === '1',
    };
}
