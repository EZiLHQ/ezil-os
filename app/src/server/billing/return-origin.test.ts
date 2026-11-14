import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingReturnOrigin, OWNED_APP_ORIGINS } from './return-origin';

const headers = (origin: string | null): Pick<Headers, 'get'> => ({ get: name => name === 'origin' ? origin : null });
const fallback = 'https://os.ezil.org';

afterEach(() => vi.unstubAllEnvs());

describe.each(['production', 'development', 'test'])('billing return origin in %s', environment => {
    it.each(OWNED_APP_ORIGINS)('accepts owned origin %s', origin => {
        vi.stubEnv('NODE_ENV', environment);
        expect(billingReturnOrigin(headers(origin))).toBe(origin);
    });

    it.each([
        'https://evil-app.ezil.org', 'https://x.vercel.app', 'null', null, 'javascript:alert(1)',
        'https://other.ezil.work', 'https://os.ezil.work.evil.example', 'http://os.ezil.work',
        'https://os.ezil.work:443', 'https://os.ezil.work/', 'https://OS.EZIL.WORK',
        'https://os.ezil.work/path', 'https://os.ezil.work?query', 'https://os.ezil.work#fragment',
        'https://user@os.ezil.work', ' https://os.ezil.work', 'https://os.ezil.work ',
        'http://localhost', 'http://127.0.0.1', 'https://localhost:3000', 'http://localhost.evil.example:3000',
        'http://localhost:3000/path', 'http://localhost:3000@evil.example', 'http://localhost:65536',
        'http://localhost:3000\n', 'http://127.0.0.1:3000\r\n',
        'http://localhost:abc', 'http://127.1:3000', 'http://0.0.0.0:3000', '',
    ])('falls back for unowned or malformed origin %#', origin => {
        vi.stubEnv('NODE_ENV', environment);
        expect(billingReturnOrigin(headers(origin))).toBe(fallback);
    });

    it('falls back when headers are absent', () => {
        vi.stubEnv('NODE_ENV', environment);
        expect(billingReturnOrigin()).toBe(fallback);
        expect(billingReturnOrigin(new Headers())).toBe(fallback);
    });

    it.each(['http://localhost:3000', 'http://127.0.0.1:8080', 'http://localhost:80', 'http://127.0.0.1:65535'])(
        'allows %s only outside production', origin => {
            vi.stubEnv('NODE_ENV', environment);
            expect(billingReturnOrigin(headers(origin))).toBe(environment === 'production' ? fallback : origin);
        },
    );
});

describe('billing return origin on a PR preview slot', () => {
    it('returns to the container\'s own slot and falls back to it, not to production', () => {
        vi.stubEnv('EZIL_DEPLOY_ENV', 'pr-preview');
        vi.stubEnv('EZIL_PR_PREVIEW_ORIGIN', 'https://os-pv1.ezil.work');
        expect(billingReturnOrigin(headers('https://os-pv1.ezil.work'))).toBe('https://os-pv1.ezil.work');
        expect(billingReturnOrigin(headers('https://os-pv2.ezil.work'))).toBe('https://os-pv1.ezil.work');
        expect(billingReturnOrigin(headers('https://evil-app.ezil.work'))).toBe('https://os-pv1.ezil.work');
        expect(billingReturnOrigin(headers('https://os-staging.ezil.work'))).toBe('https://os-staging.ezil.work');
    });

    it('treats a slot origin as unowned without the pr-preview deploy env', () => {
        vi.stubEnv('EZIL_DEPLOY_ENV', 'staging');
        vi.stubEnv('EZIL_PR_PREVIEW_ORIGIN', 'https://os-pv1.ezil.work');
        expect(billingReturnOrigin(headers('https://os-pv1.ezil.work'))).toBe(fallback);
    });
});

it('allows localhost when NODE_ENV is unset', () => {
    vi.stubEnv('NODE_ENV', undefined);
    expect(billingReturnOrigin(headers('http://localhost:3000'))).toBe('http://localhost:3000');
});
