/**
 * Functions that run INSIDE the page, via `page.evaluate`.
 *
 * Everything here is serialised to source and evaluated in the page's own
 * realm, so each function must be entirely self-contained: no closures over
 * module scope, no imports, no `const` from outside its own body.
 *
 * ── These are not a CDP passthrough ─────────────────────────────────────────
 * 🔴 The sidecar's whole reason to exist is that the reachable surface is a
 * fixed verb set. That would be worthless if a caller could hand us JS to run.
 * NOTHING in this file takes code from a request. Every function below is
 * written here, in the repository, reviewed like any other source, and the
 * only thing a caller can influence is which of them runs and — for the
 * snapshot/markdown scoping — a `data-ezil-ref` attribute value that this
 * process minted itself. If a future change makes any of these accept a
 * string that is later `eval`'d, `new Function`'d, or interpolated into a
 * selector from request input, it has reintroduced the passthrough the
 * contract forbids.
 *
 * ── Why a DOM attribute for refs ────────────────────────────────────────────
 * `click`/`type` must deliver REAL input (Playwright's `Input.*` CDP domain),
 * not `element.click()` — a synthetic JS click is not a trusted event and does
 * not reproduce what a user does. So the ref has to survive the round trip
 * from this realm back out to a Playwright locator, and an attribute is the
 * only thing that does. `data-ezil-ref` is stamped by `snapshotPage` and read
 * back by `[data-ezil-ref="eN"]`.
 *
 * The mutation is real and worth stating: the page's DOM gains one attribute
 * per snapshotted element. It is namespaced, `data-`-prefixed (so it is valid
 * HTML and inert to CSS unless a page deliberately selects on it), cleared at
 * the start of every snapshot, and it is what makes `stale_ref` detectable —
 * a framework re-render drops the attribute, the locator finds nothing, and
 * the caller is told to re-snapshot rather than being told it guessed.
 */

/**
 * Build the accessibility snapshot and stamp refs.
 *
 * Returns `{ text, refs }` where `text` is the indented tree the caller sees
 * and `refs` is `[{ ref, role, name, isPassword }]` for the sidecar's own
 * registry. Values of `input[type=password]` ARE included in `text` — the
 * redaction choke point (`redact.mjs`) is the single thing that removes them,
 * deliberately, so that deleting it goes red. See that file's header.
 */
export function snapshotPage (options) {
    const MAX_NODES = options && options.maxNodes ? options.maxNodes : 1200;
    const MAX_TEXT = 160;

    for (const stale of document.querySelectorAll('[data-ezil-ref]')) {
        stale.removeAttribute('data-ezil-ref');
    }

    let counter = 0;
    let emitted = 0;
    const refs = [];
    const lines = [];

    const clip = (s) => {
        const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
    };

    const visible = (el) => {
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
        if (el.hidden) return false;
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (!style) return true;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        // Zero-area elements that still contain laid-out children (a common
        // wrapper shape) must not prune the subtree, so only leaves are cut.
        if (rect.width === 0 && rect.height === 0 && el.children.length === 0) return false;
        return true;
    };

    const roleOf = (el) => {
        const explicit = el.getAttribute && el.getAttribute('role');
        if (explicit) return explicit.trim().split(/\s+/)[0];
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'button') return 'button';
        if (tag === 'summary') return 'button';
        if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'range') return 'slider';
            if (t === 'file') return 'button';
            if (t === 'hidden') return 'none';
            if (t === 'search') return 'searchbox';
            return 'textbox';
        }
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'img') return el.getAttribute('alt') === '' ? 'none' : 'img';
        if (tag === 'ul' || tag === 'ol') return 'list';
        if (tag === 'li') return 'listitem';
        if (tag === 'table') return 'table';
        if (tag === 'tr') return 'row';
        if (tag === 'td') return 'cell';
        if (tag === 'th') return 'columnheader';
        if (tag === 'nav') return 'navigation';
        if (tag === 'main') return 'main';
        if (tag === 'header') return 'banner';
        if (tag === 'footer') return 'contentinfo';
        if (tag === 'aside') return 'complementary';
        if (tag === 'form') return 'form';
        if (tag === 'p') return 'paragraph';
        if (tag === 'iframe' || tag === 'frame') return 'iframe';
        if (tag === 'option') return 'option';
        if (tag === 'label') return 'generic';
        if (tag === 'dialog') return 'dialog';
        if (tag === 'code' || tag === 'pre') return 'code';
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return 'none';
        return 'generic';
    };

    const labelText = (el) => {
        if (el.labels && el.labels.length > 0) {
            const parts = [];
            for (const l of el.labels) parts.push(l.textContent || '');
            const joined = clip(parts.join(' '));
            if (joined) return joined;
        }
        const wrapping = el.closest ? el.closest('label') : null;
        if (wrapping) return clip(wrapping.textContent || '');
        return '';
    };

    const nameOf = (el, role) => {
        const aria = el.getAttribute && el.getAttribute('aria-label');
        if (aria && aria.trim()) return clip(aria);
        const by = el.getAttribute && el.getAttribute('aria-labelledby');
        if (by) {
            const parts = [];
            for (const id of by.split(/\s+/)) {
                const t = el.ownerDocument.getElementById(id);
                if (t) parts.push(t.textContent || '');
            }
            const joined = clip(parts.join(' '));
            if (joined) return joined;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === 'img') return clip(el.getAttribute('alt') || el.getAttribute('title') || '');
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const fromLabel = labelText(el);
            if (fromLabel) return fromLabel;
            return clip(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '');
        }
        if (role === 'link' || role === 'button' || role === 'heading' || role === 'option'
            || role === 'listitem' || role === 'cell' || role === 'columnheader' || role === 'paragraph'
            || role === 'code') {
            return clip(el.textContent || '');
        }
        const title = el.getAttribute && el.getAttribute('title');
        return title ? clip(title) : '';
    };

    const valueOf = (el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            const opt = el.selectedOptions && el.selectedOptions[0];
            return opt ? clip(opt.textContent || opt.value || '') : '';
        }
        if (tag === 'textarea') return clip(el.value || '');
        if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox' || t === 'radio') return el.checked ? 'checked' : 'unchecked';
            if (t === 'button' || t === 'submit' || t === 'reset') return '';
            // Password values are emitted here ON PURPOSE. `redact.mjs` is the
            // one thing that removes them, so that deleting it goes red.
            return clip(el.value || '');
        }
        return '';
    };

    // Roles that earn a line of their own. A `generic` node is flattened away
    // (we recurse through it) unless it carries an accessible name, which is
    // how ~3000 tokens of div soup becomes ~200-400 tokens of structure.
    const INTERESTING = new Set([
        'link', 'button', 'checkbox', 'radio', 'slider', 'textbox', 'searchbox',
        'combobox', 'listbox', 'option', 'heading', 'img', 'list', 'listitem',
        'table', 'row', 'cell', 'columnheader', 'navigation', 'main', 'banner',
        'contentinfo', 'complementary', 'form', 'paragraph', 'iframe', 'dialog',
        'code', 'menu', 'menuitem', 'tab', 'tablist', 'tabpanel', 'alert',
        'status', 'switch', 'progressbar', 'article', 'region', 'separator',
    ]);

    const walk = (el, depth) => {
        if (emitted >= MAX_NODES) return;
        if (!el || el.nodeType !== 1) return;
        const role = roleOf(el);
        if (role === 'none') return;
        if (!visible(el)) return;

        const name = nameOf(el, role);
        const interesting = INTERESTING.has(role) || (role === 'generic' && !!name && el.children.length === 0);

        let childDepth = depth;
        if (interesting) {
            counter += 1;
            const ref = 'e' + counter;
            el.setAttribute('data-ezil-ref', ref);
            const tag = el.tagName.toLowerCase();
            const isPassword = tag === 'input'
                && (el.getAttribute('type') || '').toLowerCase() === 'password';

            const attrs = [];
            if (role === 'heading') attrs.push('[level=' + el.tagName.slice(1) + ']');
            if (el.disabled) attrs.push('[disabled]');
            if (el.ownerDocument.activeElement === el) attrs.push('[focused]');
            if (isPassword) attrs.push('[type=password]');

            const value = valueOf(el);
            let line = '- ' + role;
            if (name) line += ' "' + name.replace(/"/g, "'") + '"';
            line += ' [ref=' + ref + ']';
            if (attrs.length) line += ' ' + attrs.join(' ');
            if (value) line += ': ' + value;
            lines.push('  '.repeat(depth) + line);
            emitted += 1;
            refs.push({ ref: ref, role: role, name: name, isPassword: isPassword });
            childDepth = depth + 1;

            // A named leaf-ish control has nothing useful below it.
            if (role === 'link' || role === 'button' || role === 'heading' || role === 'textbox'
                || role === 'searchbox' || role === 'checkbox' || role === 'radio' || role === 'img'
                || role === 'paragraph' || role === 'code' || role === 'option' || role === 'iframe') {
                return;
            }
        }

        for (const child of el.children) walk(child, childDepth);
    };

    const root = options && options.rootRef
        ? document.querySelector('[data-ezil-ref="' + String(options.rootRef).replace(/[^a-zA-Z0-9]/g, '') + '"]')
        : document.body;
    if (root) walk(root, 0);

    return {
        text: lines.join('\n'),
        refs: refs,
        truncated: emitted >= MAX_NODES,
    };
}

/**
 * Render the main content (or one ref'd element) as markdown.
 *
 * Deliberately small: headings, paragraphs, lists, links, code, tables and
 * images. Not a general HTML-to-markdown port — the job is "what does this
 * page say", and everything beyond that costs tokens without answering it.
 */
export function pageMarkdown (options) {
    const MAX_CHARS = options && options.maxChars ? options.maxChars : 40000;

    const root = (() => {
        if (options && options.rootRef) {
            return document.querySelector(
                '[data-ezil-ref="' + String(options.rootRef).replace(/[^a-zA-Z0-9]/g, '') + '"]',
            );
        }
        return document.querySelector('main') || document.querySelector('article') || document.body;
    })();
    if (!root) return '';

    const out = [];
    const inlineOf = (el) => {
        let s = '';
        for (const node of el.childNodes) {
            if (node.nodeType === 3) {
                s += node.textContent;
            } else if (node.nodeType === 1) {
                const tag = node.tagName.toLowerCase();
                const style = node.ownerDocument.defaultView.getComputedStyle(node);
                if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
                if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
                if (tag === 'a' && node.hasAttribute('href')) {
                    s += '[' + inlineOf(node).trim() + '](' + node.getAttribute('href') + ')';
                } else if (tag === 'strong' || tag === 'b') {
                    s += '**' + inlineOf(node).trim() + '**';
                } else if (tag === 'em' || tag === 'i') {
                    s += '*' + inlineOf(node).trim() + '*';
                } else if (tag === 'code') {
                    s += '`' + inlineOf(node).trim() + '`';
                } else if (tag === 'br') {
                    s += '\n';
                } else if (tag === 'img') {
                    const alt = node.getAttribute('alt') || '';
                    if (alt) s += '![' + alt + ']';
                } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    // Values of form controls, password fields included, flow
                    // through here on purpose — `redact.mjs` is the guard.
                    const v = node.value == null ? '' : String(node.value);
                    if (v) s += v;
                } else {
                    s += inlineOf(node);
                }
            }
        }
        return s;
    };

    const block = (el, depth) => {
        if (out.join('\n').length > MAX_CHARS) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return;
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return;

        if (/^h[1-6]$/.test(tag)) {
            const text = inlineOf(el).replace(/\s+/g, ' ').trim();
            if (text) out.push('#'.repeat(Number(tag[1])) + ' ' + text);
            return;
        }
        if (tag === 'p') {
            const text = inlineOf(el).replace(/[ \t]+/g, ' ').trim();
            if (text) out.push(text);
            return;
        }
        if (tag === 'pre') {
            const text = el.textContent.replace(/\s+$/, '');
            if (text) out.push('```\n' + text + '\n```');
            return;
        }
        if (tag === 'ul' || tag === 'ol') {
            let i = 0;
            for (const li of el.children) {
                if (li.tagName.toLowerCase() !== 'li') continue;
                i += 1;
                const bullet = tag === 'ol' ? i + '. ' : '- ';
                const text = inlineOf(li).replace(/\s+/g, ' ').trim();
                if (text) out.push('  '.repeat(depth) + bullet + text);
                for (const nested of li.children) {
                    const nt = nested.tagName.toLowerCase();
                    if (nt === 'ul' || nt === 'ol') block(nested, depth + 1);
                }
            }
            return;
        }
        if (tag === 'table') {
            for (const tr of el.querySelectorAll('tr')) {
                const cells = [];
                for (const cell of tr.children) cells.push(inlineOf(cell).replace(/\s+/g, ' ').trim());
                if (cells.length) out.push('| ' + cells.join(' | ') + ' |');
            }
            return;
        }
        if (tag === 'blockquote') {
            const text = inlineOf(el).replace(/\s+/g, ' ').trim();
            if (text) out.push('> ' + text);
            return;
        }
        if (tag === 'hr') { out.push('---'); return; }

        if (el.children.length === 0) {
            const text = inlineOf(el).replace(/\s+/g, ' ').trim();
            if (text) out.push(text);
            return;
        }
        for (const child of el.children) block(child, depth);
    };

    block(root, 0);
    const md = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    return md.length > MAX_CHARS ? md.slice(0, MAX_CHARS) + '\n\n[truncated]' : md;
}

/**
 * Every value currently sitting in an `input[type=password]` in this frame.
 * Read by the sidecar to build the secret set the redaction pass acts on —
 * never returned to a caller.
 */
export function passwordValues () {
    const out = [];
    for (const el of document.querySelectorAll('input[type=password]')) {
        if (el.value) out.push(el.value);
    }
    return out;
}

/** Does this frame's rendered text contain `needle`? Answers a boolean only. */
export function containsText (needle) {
    const body = document.body;
    if (!body) return false;
    return (body.innerText || body.textContent || '').includes(needle);
}
