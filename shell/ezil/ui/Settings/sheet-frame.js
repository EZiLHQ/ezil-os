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
    const inert = [];
    for ( const sibling of doc.body.children ) {
        if ( sibling !== backdrop && ! sibling.hasAttribute('inert') ) {
            sibling.setAttribute('inert', '');
            inert.push(sibling);
        }
    }
    let closed = false;
    const focusable = () => [...dialog.querySelectorAll('button, input, select, textarea, summary, a[href], iframe, [tabindex]')]
        .filter(el => ! el.disabled && el.tabIndex >= 0 && ! el.dataset.focusEdge && ! el.closest('[hidden], [inert]')
            && ! [...dialog.querySelectorAll('details:not([open])')].some(details => details.contains(el) && el !== details.querySelector('summary')));
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    const focusLast = () => (focusable().at(-1) ?? dialog).focus();
    const onFocus = event => {
        if ( ! dialog.contains(event.target) || event.target.dataset.focusEdge === 'end' ) focusFirst();
        else if ( event.target.dataset.focusEdge === 'start' ) focusLast();
    };
    const onKey = event => {
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
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    function close () {
        if ( closed ) return;
        closed = true;
        observer.disconnect();
        compact?.removeEventListener('change', setCompact);
        win.removeEventListener('resize', refreshCompact);
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('focusin', onFocus, true);
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
        if ( event.target === backdrop && canDismissBackdrop() ) close();
    });
    dialog.querySelector('[data-action="close-sheet"]').addEventListener('click', close);
    refreshCompact();
    focusFirst();
    return { handle, close, dialog, content, doc, win, focusFirst, refreshCompact, get closed () { return closed; } };
}
