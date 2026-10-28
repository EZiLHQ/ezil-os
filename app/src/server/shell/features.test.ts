import { describe, expect, it } from 'vitest';

import { shellFeaturesFor } from './features';

describe('shellFeaturesFor — every flag fails closed', () => {
    it('is all-off with no env', () => {
        expect(shellFeaturesFor('a@b.c', {})).toEqual({ floatingControls: false, feedback: false, feedbackScreenshots: false });
    });
    it('only exactly "1" turns a flag on', () => {
        expect(shellFeaturesFor('a@b.c', { EZIL_OS_FEEDBACK: 'yes' }).feedback).toBe(false);
        expect(shellFeaturesFor('a@b.c', { EZIL_OS_FEEDBACK: 'true' }).feedback).toBe(false);
        expect(shellFeaturesFor('a@b.c', { EZIL_OS_FEEDBACK: '1' }).feedback).toBe(true);
    });
    it('floating controls stay off in this build, whatever the env says', () => {
        const env = { EZIL_OS_FLOATING_CONTROLS: '1', EZIL_OS_FEEDBACK: '1' } as Parameters<typeof shellFeaturesFor>[1];
        expect(shellFeaturesFor('a@b.c', env).floatingControls).toBe(false);
    });
    it('screenshots need feedback on', () => {
        expect(shellFeaturesFor('a@b.c', { EZIL_OS_FEEDBACK_SCREENSHOTS: '1' }).feedbackScreenshots).toBe(false);
        expect(shellFeaturesFor('a@b.c', { EZIL_OS_FEEDBACK: '1', EZIL_OS_FEEDBACK_SCREENSHOTS: '1' }).feedbackScreenshots).toBe(true);
    });
    it('a pilot list narrows feedback to listed emails, case-insensitively', () => {
        const e = { EZIL_OS_FEEDBACK: '1', EZIL_OS_FEEDBACK_SCREENSHOTS: '1', FEEDBACK_PILOT_EMAILS: ' Founder@Ezil.work , x@y.z' };
        expect(shellFeaturesFor('founder@ezil.work', e).feedback).toBe(true);
        expect(shellFeaturesFor('other@ezil.work', e)).toMatchObject({ feedback: false, feedbackScreenshots: false });
        expect(shellFeaturesFor(null, e).feedback).toBe(false);
    });
});
