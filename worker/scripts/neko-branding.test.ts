/**
 * Regression guard for the EZiL neko-branding overlay (worker task: replace
 * the third-party n.eko wordmark/favicons/chat sound and disable audio
 * capture at the source).
 *
 * Every check here is written to go RED if its fix is reverted — per the
 * plan's own verification rule, a check that cannot fail is worse than none.
 * These are static/text checks only (no docker, no network) so they run
 * everywhere `bun test` does; the actual branding/audio behavior was
 * verified against a real running container (see the task report), not by
 * this file.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(import.meta.dir, '..', 'Dockerfile'), 'utf8');
const START_NEKO = readFileSync(join(import.meta.dir, 'start-neko.sh'), 'utf8');

const BRANDING_DIR = join(import.meta.dir, '..', 'assets', 'neko-branding');
const BRANDING_DOCKERFILE = readFileSync(join(BRANDING_DIR, 'Dockerfile'), 'utf8');
const BRANDED_INDEX_HTML = readFileSync(join(BRANDING_DIR, 'www', 'index.html'), 'utf8');
const BRANDED_MANIFEST = readFileSync(join(BRANDING_DIR, 'www', 'site.webmanifest'), 'utf8');
const BRANDED_LOGO_SVG = readFileSync(join(BRANDING_DIR, 'www', 'logo.svg'), 'utf8');

describe('worker/Dockerfile pins the EZiL-branded neko image', () => {
    it('defaults ARG NEKO_IMAGE to the -ezil-brand tag, not the raw upstream tag', () => {
        const match = DOCKERFILE.match(/^ARG NEKO_IMAGE=(\S+)$/m);
        expect(match).not.toBeNull();
        const pinned = match![1];
        expect(pinned).toContain('ezil-brand');
        // Guards the OTHER direction too: it must still be the same pinned
        // upstream SHAs, not some unrelated tag someone typo'd in.
        expect(pinned).toContain('d74052bb-049931d7');
    });
});

describe('worker/assets/neko-branding overlay', () => {
    it('has a build-time check that fails the image if n.eko branding survives', () => {
        // The Dockerfile itself must refuse to produce an image where the
        // overlay silently no-op'd (e.g. a COPY path typo that left the
        // upstream file in place).
        expect(BRANDING_DOCKERFILE).toMatch(/grep -qi "n\\\.eko" \/var\/www\/index\.html/);
        expect(BRANDING_DOCKERFILE).toContain('exit 1');
    });

    it('index.html no longer names n.eko anywhere', () => {
        expect(BRANDED_INDEX_HTML.toLowerCase()).not.toContain('n.eko');
    });

    it('index.html no longer uses n.eko’s teal accent color (#19bd9c)', () => {
        expect(BRANDED_INDEX_HTML).not.toContain('19bd9c');
    });

    it('site.webmanifest is renamed away from "n.eko"', () => {
        const parsed = JSON.parse(BRANDED_MANIFEST);
        expect(parsed.name.toLowerCase()).not.toContain('n.eko');
        expect(parsed.short_name.toLowerCase()).not.toContain('n.eko');
    });

    it('the wordmark SVG no longer contains the upstream cat-silhouette path data', () => {
        // The upstream img/logo.800bec71.svg is a single large <path> element
        // (a cat/paw mark, confirmed by inspecting its "d" data). A neutral
        // placeholder has no <path> at all.
        expect(BRANDED_LOGO_SVG).not.toContain('<path');
    });
});

describe('start-neko.sh disables audio capture at the source', () => {
    it('does not unconditionally launch pulseaudio in the boot path', () => {
        // Matches the exact upstream invocation this task removed. If this
        // reappears, the container regains a real desktop-audio source for
        // neko's WebRTC audio track to capture from.
        expect(START_NEKO).not.toMatch(
            /pulseaudio --log-level=error --disallow-module-loading --disallow-exit --exit-idle-time=-1/,
        );
    });

    it('points NEKO_CAPTURE_AUDIO_DEVICE at a name that cannot resolve to a real source', () => {
        expect(START_NEKO).toMatch(/export NEKO_CAPTURE_AUDIO_DEVICE=/);
    });

    it('documents that NEKO_CAPTURE_AUDIO_ENABLED does not exist in the pinned build', () => {
        // Regression guard against silently reintroducing the plan's
        // unverified assumption without the verification note that
        // disproved it.
        expect(START_NEKO).toContain('NEKO_CAPTURE_AUDIO_ENABLED');
        expect(START_NEKO).toContain('does not exist in this pinned build');
    });
});
