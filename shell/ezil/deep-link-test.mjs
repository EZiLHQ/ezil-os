// deep-link-test.mjs — `/app/<name>` arrivals (`deep-link.js`), driven with a
// fake location and history so every rule is checked without a browser.
//
// The rules: read once per page load; clean the address bar to `/os` so a
// launch code never stays in history; accept only registry-shaped ids.
import { takeDeepLink, resetDeepLinkForTest } from './deep-link.js';

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass: !! pass, detail });

function arrive (href) {
    resetDeepLinkForTest();
    const url = new URL(href, 'https://os.example.test');
    const loc = { pathname: url.pathname, search: url.search, hash: url.hash };
    const calls = [];
    const hist = { state: { keep: true }, replaceState (state, _title, to) { calls.push({ state, to }); loc.pathname = to; loc.search = ''; loc.hash = ''; } };
    return { loc, hist, calls };
}

{
    const a = arrive('/app/settings');
    const link = takeDeepLink(a.loc, a.hist);
    push('/app/settings names settings', link?.app === 'settings' && link.launchCode === null);
    push('the address bar becomes /os, keeping history state', a.calls.length === 1 && a.calls[0].to === '/os' && a.calls[0].state?.keep === true);
    push('🔴 a second take (a rebuild) opens nothing', takeDeepLink(a.loc, a.hist) === null && a.calls.length === 1);
}

{
    const code = 'A'.repeat(42) + 'w';
    const a = arrive(`/app/code?task=t-1&project=p-1&repository=r-1&ref=refs%2Fheads%2Fmain#c=${code}`);
    const link = takeDeepLink(a.loc, a.hist);
    push('/app/code carries its query hints', link?.app === 'code' && link.query.task === 't-1' && link.query.ref === 'refs/heads/main');
    push('/app/code carries the fragment launch code', link?.launchCode === code);
    push('🔴 the launch code is gone from the address bar', a.loc.hash === '' && a.calls[0].to === '/os');
}

{
    const a = arrive('/app/app-store/');
    push('a trailing slash is accepted', takeDeepLink(a.loc, a.hist)?.app === 'app-store');
}

for ( const href of ['/os', '/', '/computers', '/app/', '/app/Code', '/app/code/extra', '/app/-code', '/app/code--x', '/app/..', '/app/%2e%2e', `/app/${'a'.repeat(41)}`, '/application/code'] ) {
    const a = arrive(href);
    const link = takeDeepLink(a.loc, a.hist);
    const touched = a.calls.length > 0;
    push(`${href} opens nothing`, link === null, touched ? 'url rewritten' : '');
    // Only a path that LOOKS like an app route is rewritten; /os and friends are left alone.
    if ( ! href.startsWith('/app/') || href === '/application/code' ) push(`${href} is left untouched`, ! touched);
}

{
    const a = arrive('/app/settings');
    a.hist.replaceState = () => { throw new Error('SecurityError'); };
    push('a history that refuses replaceState does not throw', takeDeepLink(a.loc, a.hist)?.app === 'settings');
}

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
