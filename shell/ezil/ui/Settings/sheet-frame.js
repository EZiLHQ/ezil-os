// Shared, document-owned modal lifetime for checkout and billing changes.
const sheets = new WeakMap();

export function openSheetFrame ({ container, title, role = 'billing-sheet', sheet, onClose, dispose, canDismissBackdrop = () => true, onCompact }) {
    container = container?.get?.(0) ?? container;
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    if ( sheets.has(doc) ) return { existing: sheets.get(doc) };
    const opener = doc.activeElement;
    const backdrop = doc.createElement('div');
    backdrop.className = 'ezil-upgrade-backdrop';
    backdrop.innerHTML = `<div class="ezil-upgrade-sheet" role="dialog" aria-modal="true" tabindex="-1">
        <span data-focus-edge="start" tabindex="0"></span>
        <button type="button" class="ezil-upgrade-close" data-action="close-sheet" aria-label="Close billing sheet">×</button>
        <div data-role="sheet-content"></div>
        <span data-focus-edge="end" tabindex="0"></span>
    </div>`;
    const dialog = backdrop.querySelector('[role="dialog"]');
    dialog.dataset.role = role;
    if ( sheet ) dialog.dataset.sheet = sheet;
    dialog.setAttribute('aria-label', title);
    const content = dialog.querySelector('[data-role="sheet-content"]');
    const oldOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';
    doc.body.append(backdrop);
    // Only undo inert that this frame added, including siblings added later.
    const inert = new Set();
    let closed = false;
    let provider = null;
    let portals = [];
    let returnFocus = null;
    let lastSheetFocus = null;
    let syncing = false;
    let closePending = false;
    let closeTimer = null;
    const closingRoots = new Map();
    const hidden = element => {
        for ( let node = element; node && node !== doc.body; node = node.parentElement ) {
            const style = win.getComputedStyle(node);
            if ( node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
                || style.visibility === 'hidden' || style.visibility === 'collapse' ) return true;
        }
        return false;
    };
    const focusable = () => [...dialog.querySelectorAll('button, input, select, textarea, summary, a[href], iframe, [tabindex]')]
        .filter(el => ! el.disabled && el.tabIndex >= 0 && ! el.dataset.focusEdge && ! el.closest('[hidden], [inert]')
            && ! [...dialog.querySelectorAll('details:not([open])')].some(details => details.contains(el) && el !== details.querySelector('summary')));
    const focusProvider = () => {
        if ( ! portals.some(({ root }) => root.contains(doc.activeElement)) ) portals.at(-1)?.iframe.focus();
    };
    const focusFirst = () => portals.length ? focusProvider() : (focusable()[0] ?? dialog).focus();
    const focusLast = () => portals.length ? focusProvider() : (focusable().at(-1) ?? dialog).focus();
    function releaseInert (element) {
        if ( inert.delete(element) ) element.removeAttribute('inert');
    }
    function providerFrame (root) {
        if ( ! provider || provider.baseline.has(root) ) return null;
        // Stripe's body lightbox is a dedicated div containing its iframe.
        // Never exempt an application subtree just because it contains one.
        let node = root;
        while ( node.tagName === 'DIV' && node.children.length === 1 && ! [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()) ) {
            if ( node !== root && node.hasAttribute('inert') ) return null;
            node = node.firstElementChild;
        }
        if ( node.tagName !== 'IFRAME' || (node.hasAttribute('inert') && ! inert.has(node)) ) return null;
        if ( root.hasAttribute('inert') && ! inert.has(root) ) return null;
        return provider.matchesFrame(node) ? node : null;
    }
    function sync () {
        if ( closed || syncing ) return;
        syncing = true;
        try {
            const next = [];
            for ( const sibling of doc.body.children ) {
                if ( sibling === backdrop ) continue;
                const iframe = providerFrame(sibling);
                if ( iframe ) {
                    releaseInert(sibling);
                    if ( ! hidden(iframe) ) next.push({ root: sibling, iframe });
                } else if ( ! sibling.hasAttribute('inert') ) {
                    sibling.setAttribute('inert', '');
                    inert.add(sibling);
                }
            }
            const wasActive = portals.length > 0;
            portals = next;
            if ( portals.length ) {
                if ( closePending ) for ( const { root, iframe } of portals ) closingRoots.set(root, iframe);
                if ( ! wasActive ) returnFocus = dialog.contains(doc.activeElement) ? doc.activeElement : lastSheetFocus;
                dialog.setAttribute('inert', '');
                dialog.setAttribute('aria-modal', 'false');
                focusProvider();
            } else if ( wasActive ) {
                dialog.removeAttribute('inert');
                dialog.setAttribute('aria-modal', 'true');
                if ( ! closePending ) {
                    if ( returnFocus?.isConnected && dialog.contains(returnFocus) && ! hidden(returnFocus) && ! returnFocus.disabled ) returnFocus.focus();
                    else focusFirst();
                }
                returnFocus = null;
            }
        } finally { syncing = false; }
        finishPendingClose();
    }
    const providerStillClosing = () => [...closingRoots].some(([root, iframe]) => root.isConnected && ! hidden(root)
        && (! iframe.isConnected || ! hidden(iframe)));
    function finishPendingClose () {
        if ( ! closePending || closeTimer !== null || portals.length || providerStillClosing() ) return;
        // Stripe restores scrolling in its hide routine and tab stops in queued
        // tasks. Never destroy its visible modal before that routine can run.
        closeTimer = win.setTimeout(() => {
            sync();
            closeTimer = null;
            if ( ! portals.length && ! providerStillClosing() ) disposeFrame();
        }, 0);
    }
    /** Opt in only for the lifetime of the embedded provider instance. */
    function registerProviderPortals ({ matchesFrame }) {
        const registration = { matchesFrame, baseline: new Set(doc.body.children) };
        provider = registration;
        sync();
        return () => {
            if ( provider !== registration ) return;
            provider = null;
            sync();
        };
    }
    const onFocus = event => {
        sync();
        if ( portals.length ) { focusProvider(); return; }
        if ( ! dialog.contains(event.target) || event.target.dataset.focusEdge === 'end' ) focusFirst();
        else if ( event.target.dataset.focusEdge === 'start' ) focusLast();
        else lastSheetFocus = event.target;
    };
    const onKey = event => {
        sync();
        // The provider owns its own trap and dismissal while its modal is up.
        if ( portals.length ) return;
        if ( event.key === 'Escape' ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
        } else if ( event.key === 'Tab' ) {
            const elements = focusable();
            if ( event.shiftKey && doc.activeElement === elements[0] ) { event.preventDefault(); focusLast(); }
            else if ( ! event.shiftKey && doc.activeElement === elements.at(-1) ) { event.preventDefault(); focusFirst(); }
        }
    };
    const compact = win.matchMedia?.('(max-width: 759px)');
    const setCompact = event => {
        backdrop.classList.toggle('is-compact', event.matches);
        onCompact?.(event.matches, dialog);
    };
    const refreshCompact = () => setCompact({ matches: win.innerWidth < 760 });
    compact?.addEventListener('change', setCompact);
    win.addEventListener('resize', refreshCompact);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    const observer = new win.MutationObserver(() => {
        if ( ! backdrop.isConnected || ! container.isConnected ) close();
        else sync();
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['src', 'srcdoc', 'style', 'class', 'hidden', 'aria-hidden'] });
    function close () {
        if ( closed ) return;
        if ( portals.length ) {
            closePending = true;
            for ( const { root, iframe } of portals ) closingRoots.set(root, iframe);
        }
        sync();
        if ( portals.length ) {
            closePending = true;
            for ( const { root, iframe } of portals ) closingRoots.set(root, iframe);
        }
        if ( closePending ) { finishPendingClose(); return; }
        disposeFrame();
    }
    function disposeFrame () {
        if ( closed ) return;
        closed = true;
        if ( closeTimer !== null ) win.clearTimeout(closeTimer);
        observer.disconnect();
        compact?.removeEventListener('change', setCompact);
        win.removeEventListener('resize', refreshCompact);
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('focusin', onFocus, true);
        provider = null;
        portals = [];
        try { dispose?.(); } finally {
            for ( const sibling of inert ) sibling.removeAttribute('inert');
            backdrop.remove();
            doc.body.style.overflow = oldOverflow;
            sheets.delete(doc);
            if ( opener?.isConnected ) opener.focus();
            onClose?.();
        }
    }
    const handle = { close };
    sheets.set(doc, handle);
    backdrop.addEventListener('click', event => {
        sync();
        if ( ! portals.length && event.target === backdrop && canDismissBackdrop() ) close();
    });
    dialog.querySelector('[data-action="close-sheet"]').addEventListener('click', () => {
        sync();
        if ( ! portals.length ) close();
    });
    refreshCompact();
    sync();
    focusFirst();
    return { handle, close, dialog, content, doc, win, focusFirst, refreshCompact, registerProviderPortals, get closed () { return closed; } };
}
