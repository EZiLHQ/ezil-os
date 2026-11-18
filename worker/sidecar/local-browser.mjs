import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { redactDeep } from './redact.mjs';

const SOCKET_NAME = 'ezil-local-browser.sock';
const SHARE_MS = 10 * 60_000;
const CANDIDATE_MS = 30_000;
const MAX_CANDIDATES = 24;
const MAX_SHARES = 8;
const MAX_BODY = 4096;
const CONTROL_PORTS = new Set([3000, 8080, 8181, 8443, 9222, 9223]);
const TOKEN = /^[a-f0-9]{48}$/;
const REF = /^e[a-f0-9]{24}$/;
const id = (bytes = 24) => randomBytes(bytes).toString('hex');
const fail = (error) => ({ ok: false, error });

export function localOrigin(raw) {
    try {
        const url = new URL(raw);
        const port = Number(url.port);
        return ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && !url.username && !url.password && port >= 1024 && !CONTROL_PORTS.has(port)
            ? url.origin : undefined;
    } catch {
        return undefined;
    }
}

async function visibleAt(page, origin) {
    if (page.isClosed() || localOrigin(page.url()) !== origin) return false;
    try {
        return await page.mainFrame().evaluate(expected =>
            location.origin === expected && document.visibilityState === 'visible', origin);
    } catch {
        return false;
    }
}

// All code run inside Chrome lives here. The caller cannot supply a script, selector or URL.
function capturePage(expectedOrigin) {
    if (location.origin !== expectedOrigin || document.visibilityState !== 'visible') {
        return { elements: [], snapshot: null, secrets: [] };
    }
    const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const privateSelector = 'input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"],[hidden],[aria-hidden="true"]';
    const visible = (element) => {
        if (element.closest(privateSelector)) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0
            && bounds.left < innerWidth && bounds.top < innerHeight && style.visibility === 'visible'
            && style.opacity !== '0' && (typeof element.checkVisibility !== 'function'
                || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    };
    const secrets = [];
    for (const field of document.querySelectorAll('input,textarea,select')) {
        if (secrets.length === 100) break;
        const value = field.value;
        if (typeof value === 'string' && value.length >= 3 && value.length <= 1024) secrets.push(value);
    }

    const elements = [];
    const targets = [];
    let visited = 0;
    for (const el of document.querySelectorAll('button,a[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"]')) {
        if (++visited > 400 || targets.length === 24) break;
        if (!visible(el) || el.matches(':disabled,[aria-disabled="true"]')) continue;
        const anchor = el.closest('a[href]');
        if (anchor && (anchor.origin !== location.origin || anchor.hasAttribute('download')
            || (anchor.target && anchor.target !== '_self'))) continue;
        if (el instanceof HTMLButtonElement && el.form && el.type === 'submit') continue;
        const label = clip(el.getAttribute('aria-label') || el.innerText, 100);
        if (!label) continue;
        elements.push(el);
        targets.push({ label, kind: anchor ? 'link' : 'control' });
    }

    const snippets = [];
    let length = 0;
    if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node, count = 0; count < 2000 && length < 3800 && (node = walker.nextNode()); count++) {
            const element = node.parentElement;
            if (!element || element.closest('script,style,noscript,template') || !visible(element)) continue;
            const s = clip(node.nodeValue, Math.min(250, 3800 - length));
            if (s) { snippets.push(s); length += s.length + 1; }
        }
    }
    return { elements, snapshot: { title: clip(document.title, 150), text: snippets.join('\n'), targets }, secrets };
}

function stillClickable(el, { origin, label }) {
    if (!el.isConnected || location.origin !== origin || document.visibilityState !== 'visible') return false;
    if (!el.matches('button,a[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"]')
        || el.matches(':disabled,[aria-disabled="true"]')
        || el.closest('input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]')) return false;
    const anchor = el.closest('a[href]');
    if (anchor && (anchor.origin !== origin || anchor.hasAttribute('download')
        || (anchor.target && anchor.target !== '_self'))) return false;
    if (String(el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100) !== label) return false;
    return !(el instanceof HTMLButtonElement && el.form && el.type === 'submit');
}

export class LocalBrowserShares {
    candidates = new Map();
    shares = new Map();

    constructor(connect) {
        this.connect = connect;
    }

    async list() {
        const browser = await this.connect();
        const result = [];
        for (const [key, value] of this.candidates) if (value.until < Date.now()) this.candidates.delete(key);
        for (const context of browser.contexts()) {
            for (const page of context.pages()) {
                if (result.length >= MAX_CANDIDATES) break;
                const origin = localOrigin(page.url());
                if (!origin || !await visibleAt(page, origin)) continue;
                const currentUrl = page.url();
                if (localOrigin(currentUrl) !== origin) continue;
                const key = id();
                while (this.candidates.size >= MAX_CANDIDATES * 2) this.candidates.delete(this.candidates.keys().next().value);
                this.candidates.set(key, { page, origin, until: Date.now() + CANDIDATE_MS });
                result.push({ key, origin, path: new URL(currentUrl).pathname.slice(0, 160) });
            }
        }
        return { ok: true, candidates: result };
    }

    async grant(key, origin) {
        const item = this.candidates.get(key);
        this.candidates.delete(key);
        if (!item || item.until < Date.now() || item.origin !== origin || !await visibleAt(item.page, origin)) return fail('tab_unavailable');
        if (this.shares.size >= MAX_SHARES) return fail('share_limit');
        const capability = id();
        const share = {
            page: item.page, origin, refs: new Map(), generation: 0, expiresAt: Date.now() + SHARE_MS,
        };
        const close = () => this.revoke(capability);
        const navigated = (frame) => {
            if (frame !== share.page.mainFrame()) return;
            this.clearRefs(share);
            if (localOrigin(share.page.url()) !== origin) close();
        };
        share.cleanup = () => {
            share.page.off('close', close);
            share.page.off('crash', close);
            share.page.off('framenavigated', navigated);
            clearTimeout(share.timer);
        };
        share.page.once('close', close);
        share.page.once('crash', close);
        share.page.on('framenavigated', navigated);
        share.timer = setTimeout(close, SHARE_MS);
        share.timer.unref();
        this.shares.set(capability, share);
        return { ok: true, capability, origin, expiresAt: share.expiresAt };
    }

    clearRefs(share) {
        ++share.generation;
        for (const ref of share.refs.values()) void ref.handle.dispose().catch(() => {});
        share.refs.clear();
    }

    revoke(capability) {
        const share = this.shares.get(capability);
        if (share) {
            this.shares.delete(capability);
            share.cleanup();
            this.clearRefs(share);
        }
        return { ok: true };
    }

    async current(capability) {
        const share = this.shares.get(capability);
        if (!share) return undefined;
        if (share.expiresAt <= Date.now() || share.page.isClosed() || localOrigin(share.page.url()) !== share.origin) {
            this.revoke(capability);
            return undefined;
        }
        return await visibleAt(share.page, share.origin) && this.shares.get(capability) === share ? share : undefined;
    }

    async read(capability) {
        const share = await this.current(capability);
        if (!share) return fail('share_unavailable');
        this.clearRefs(share);
        const generation = share.generation;
        let root;
        let group;
        let properties;
        try {
            root = await share.page.mainFrame().evaluateHandle(capturePage, share.origin);
            group = await root.getProperty('elements');
            properties = await group.getProperties();
            const { snapshot, secrets } = await root.evaluate(({ snapshot, secrets }) => ({ snapshot, secrets }));
            if (!snapshot || generation !== share.generation || await this.current(capability) !== share
                || generation !== share.generation) return fail('share_unavailable');
            const safe = redactDeep(snapshot, secrets);
            const targets = safe.targets.map((target, i) => {
                const handle = properties.get(String(i))?.asElement();
                if (!handle) return undefined;
                const ref = 'e' + id(12);
                properties.delete(String(i));
                share.refs.set(ref, { handle, label: snapshot.targets[i].label });
                return { ...target, ref };
            }).filter(Boolean);
            return { ok: true, origin: share.origin, title: safe.title, text: safe.text, targets };
        } catch {
            return fail('read_failed');
        } finally {
            if (properties) for (const value of properties.values()) void value.dispose().catch(() => {});
            if (group) void group.dispose().catch(() => {});
            if (root) void root.dispose().catch(() => {});
        }
    }

    async click(capability, ref, clientConnected = () => true) {
        const share = await this.current(capability);
        if (!share) return fail('share_unavailable');
        const target = share.refs.get(ref);
        if (!target) return fail('stale_ref');
        share.refs.delete(ref); // consume once, including any failure
        const scope = { origin: share.origin, label: target.label };
        const { handle } = target;
        const generation = share.generation;
        try {
            if (!clientConnected() || !await handle.evaluate(stillClickable, scope)) return fail('stale_ref');
            await handle.click({ trial: true, timeout: 700 });
            if (await this.current(capability) !== share || generation !== share.generation
                || !await handle.evaluate(stillClickable, scope)
                || this.shares.get(capability) !== share || generation !== share.generation || !clientConnected()) return fail('stale_ref');
            await handle.click({ timeout: 700 });
            return { ok: true };
        } catch {
            return fail('click_failed');
        } finally {
            void handle.dispose().catch(() => {});
        }
    }

    dispose() {
        for (const key of this.shares.keys()) this.revoke(key);
        this.candidates.clear();
    }
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return undefined;
        chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
}

export function createLocalBrowserServer(shares) {
    async function route(req, res) {
        if (req.method !== 'POST' || req.headers.origin || req.headers['sec-fetch-site']
            || req.headers['content-type'] !== 'application/json') return fail('bad_request');
        const b = await readBody(req);
        if (!b) return fail('bad_request');
        const keys = Object.keys(b).sort().join(',');
        if (req.url === '/candidates' && keys === '') return shares.list();
        if (req.url === '/share' && keys === 'key,origin' && typeof b.key === 'string' && TOKEN.test(b.key)
            && typeof b.origin === 'string' && b.origin === localOrigin(b.origin)) return shares.grant(b.key, b.origin);
        if (typeof b.capability !== 'string' || !TOKEN.test(b.capability)) return fail('bad_request');
        if (req.url === '/read' && keys === 'capability') return shares.read(b.capability);
        if (req.url === '/probe' && keys === 'capability') return { ok: !!await shares.current(b.capability) };
        if (req.url === '/revoke' && keys === 'capability') return shares.revoke(b.capability);
        if (req.url === '/click' && keys === 'capability,ref' && typeof b.ref === 'string' && REF.test(b.ref)) {
            return shares.click(b.capability, b.ref, () => !res.destroyed);
        }
        return fail('bad_request');
    }

    return createServer({ requestTimeout: 12_000, headersTimeout: 5_000 }, async (req, res) => {
        let result;
        try { result = await route(req, res); } catch { result = fail('browser_unavailable'); }
        if (!res.destroyed) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(result));
        }
    });
}

export function startLocalBrowserSocket(surface, runtimeDir) {
    if (!runtimeDir || !process.getuid) return undefined;
    const dir = lstatSync(runtimeDir);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return undefined;
    const socket = join(runtimeDir, SOCKET_NAME);
    try {
        const old = lstatSync(socket);
        if (!old.isSocket() || old.uid !== process.getuid()) return undefined;
        unlinkSync(socket); // start-neko holds the container boot mutex
    } catch (error) {
        if (error.code !== 'ENOENT') return undefined;
    }
    const shares = new LocalBrowserShares(() => surface.connect());
    const server = createLocalBrowserServer(shares);
    server.on('error', () => console.warn('[ezil-sidecar] local browser socket unavailable'));
    server.once('close', () => shares.dispose());
    server.listen(socket, () => {
        try { chmodSync(socket, 0o600); } catch { server.close(); }
    });
    return server;
}
