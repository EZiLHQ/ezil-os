import { describe, expect, it } from 'vitest';

import { CONTROL_HINT_COPY, shouldShowControlHint } from './cloudflare-guacamole-canvas';

/**
 * The fallback for a computer that cannot be clicked into.
 *
 * `enableImplicitHosting` (server side) normally makes a plain click take
 * control, and then there is nothing to explain. When it cannot — the desktop
 * still works, but a click on it is silently ignored — the user must be told
 * where Neko's own control button is, or they are left with a computer that
 * looks broken.
 *
 * Both failure directions matter, so both are asserted here: a hint that shows
 * up over a perfectly healthy desktop is a permanent nag on the one surface
 * that is supposed to be nothing but the user's own screen, and a hint that
 * cannot be dismissed is the same defect with extra steps.
 */
describe('shouldShowControlHint', () => {
    it('says nothing when a click already takes control', () => {
        expect(shouldShowControlHint('implicit', false)).toBe(false);
    });

    it('speaks up when control could not be made implicit', () => {
        expect(shouldShowControlHint('manual', false)).toBe(true);
    });

    it('stays quiet once dismissed', () => {
        expect(shouldShowControlHint('manual', true)).toBe(false);
    });

    it('says nothing when the server did not report a control mode at all', () => {
        // An older/rolled-back server omits the field. Silence is the right
        // default: guessing 'manual' would nag every healthy desktop.
        expect(shouldShowControlHint(undefined, false)).toBe(false);
    });

    it('tells the user what to do, not that something is broken', () => {
        // The button it points at is Neko's `fa-computer-mouse` icon in the
        // video's top-right corner, which `embed=1` keeps visible.
        expect(CONTROL_HINT_COPY).toMatch(/mouse icon/i);
        expect(CONTROL_HINT_COPY).toMatch(/top right/i);
        expect(CONTROL_HINT_COPY).toMatch(/take control/i);
    });
});
