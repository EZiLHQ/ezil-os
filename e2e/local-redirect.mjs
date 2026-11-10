/**
 * Redirect-target validation for the auth-recovery fixture IdP (shared so it is testable without a browser).
 *
 * A redirect is safe only when it parses as an http(s) URL with the configured local app's exact scheme and
 * origin and no embedded credentials. `new URL(value)` with no base throws on a relative (`/path`),
 * protocol-relative (`//evil`) or backslash (`/\evil`) input; a foreign or look-alike origin
 * (`http://localhost:3187.evil.example`) fails the origin check; a `blob:`/`data:` URL that merely inherits the
 * origin fails the scheme check; and a `user:pass@host` target fails the credentials check. Returns the
 * normalized href to redirect to, or null to refuse — the IdP then answers 404 rather than reflecting an
 * attacker-controlled Location (js/server-side-unvalidated-url-redirection).
 */
export function safeLocalRedirect(value, appOrigin) {
    if (typeof value !== 'string' || value === '') return null;
    let url, app;
    try {
        url = new URL(value);
        app = new URL(appOrigin);
    } catch {
        return null;
    }
    const httpScheme = url.protocol === 'http:' || url.protocol === 'https:';
    return httpScheme && url.protocol === app.protocol && url.origin === app.origin
        && url.username === '' && url.password === ''
        ? url.href : null;
}
