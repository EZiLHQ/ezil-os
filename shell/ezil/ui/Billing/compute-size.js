import { billingEnabled, text } from './text.js';
import { ensurePanelStyles, panelIcon } from './style-panels.js';

// The host supplies compute.shapes and the shape-change mutation. Eligibility
// here is presentation only; the server must check it again on start/claim.
export function mountComputeSize (container, {
    config, getShapes, getComputer, changeShape, confirmChange, onUpgrade,
} = {}) {
    if ( ! billingEnabled(config) || ! container || ! getShapes ) return null;
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);
    const section = doc.createElement('section');
    section.className = 'ezil-billing-compute';
    section.dataset.role = 'compute-size';
    const title = doc.createElement('h3');
    title.className = 'ezil-billing-compute-title';
    title.textContent = text('compute_card_title');
    const description = doc.createElement('p');
    description.className = 'ezil-billing-compute-description';
    description.textContent = text('compute_card_virtual_cpus');
    const banner = doc.createElement('div');
    banner.className = 'ezil-billing-compute-banner';
    banner.hidden = true;
    const list = doc.createElement('div');
    list.className = 'ezil-billing-compute-grid';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', text('compute_card_title'));
    const status = doc.createElement('p');
    status.className = 'ezil-billing-compute-status';
    status.setAttribute('role', 'status');
    section.append(title, description, banner, list, status);
    container.append(section);
    let busy = false;
    let shapes = [];

    function render () {
        list.replaceChildren();
        banner.replaceChildren();
        banner.hidden = ! shapes.some(shape => shape.eligible !== true);
        const computer = getComputer?.();
        const currentShape = computer?.id ? computer.shape ?? 'standard' : null;
        for ( const shape of shapes ) {
            const current = shape.id === currentShape;
            const locked = shape.eligible !== true;
            const name = ['standard', 'performance'].includes(shape.id) ? text(`compute_card_${shape.id}`) : shape.id;
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = `ezil-billing-compute-card${locked ? ' ezil-billing-compute-card-locked' : ''}`;
            button.dataset.shape = shape.id;
            button.setAttribute('role', 'radio');
            button.setAttribute('aria-checked', String(current));
            button.disabled = busy || locked || ! changeShape || ! confirmChange || ! computer?.id;
            const heading = doc.createElement('span');
            heading.className = 'ezil-billing-compute-card-head';
            const label = doc.createElement('span');
            label.textContent = name;
            heading.append(label);
            if ( current ) {
                const pill = doc.createElement('span');
                pill.className = 'ezil-billing-compute-current';
                pill.textContent = text('compute_card_current');
                heading.append(pill);
            }
            const specs = doc.createElement('span');
            specs.className = 'ezil-billing-compute-specs';
            for ( const kind of ['cpu', 'memory', 'disk'] ) {
                const row = doc.createElement('span');
                row.className = 'ezil-billing-compute-spec';
                row.append(panelIcon(doc, kind), text(`compute_card_${kind}`, shape));
                specs.append(row);
            }
            button.append(heading, specs);
            if ( locked ) {
                const reason = doc.createElement('span');
                reason.className = 'ezil-billing-compute-reason';
                reason.append(panelIcon(doc, 'lock'), text(shape.reason === 'subscription_required' ? 'compute_card_requires_cloud' : 'compute_ineligible'));
                button.title = reason.textContent;
                button.append(reason);
            }
            button.addEventListener('click', async event => {
                if ( button.disabled || busy || current || event.detail > 1 ) return;
                const computer = getComputer?.();
                if ( ! computer?.id ) return;
                busy = true;
                render();
                try {
                    const confirmed = await confirmChange({
                        computer, shape, message: text('compute_card_restart_warning', { ...shape, name }),
                        confirmLabel: text('compute_card_confirm'), cancelLabel: text('compute_card_cancel'),
                    });
                    if ( confirmed !== true || ! section.isConnected ) return;
                    // A session switch while confirming must not resize another computer.
                    if ( getComputer?.()?.id !== computer.id ) return;
                    const result = await changeShape({ computerId: computer.id, shape: shape.id });
                    if ( result?.ok === false ) throw new Error('shape change refused');
                    status.textContent = text('compute_change_requested');
                } catch {
                    status.textContent = text('compute_change_failed');
                } finally {
                    busy = false;
                    render();
                }
            });
            list.append(button);
        }
        const cards = [...list.querySelectorAll('button')];
        const tabStop = cards.find(card => ! card.disabled && card.getAttribute('aria-checked') === 'true')
            ?? cards.find(card => ! card.disabled);
        for ( const card of cards ) card.tabIndex = card === tabStop ? 0 : -1;
        if ( ! banner.hidden ) {
            const copy = doc.createElement('span');
            copy.className = 'ezil-billing-compute-banner-copy';
            copy.textContent = text('compute_card_upgrade_banner');
            const upgrade = doc.createElement('button');
            upgrade.type = 'button';
            upgrade.className = 'ezil-billing-button ezil-billing-button-primary';
            upgrade.dataset.action = 'upgrade';
            upgrade.textContent = text('compute_card_upgrade');
            upgrade.disabled = busy || ! onUpgrade;
            upgrade.addEventListener('click', async event => {
                if ( upgrade.disabled || busy || event.detail > 1 ) return;
                busy = true;
                render();
                try { await onUpgrade(); await refresh(); }
                catch { status.textContent = text('compute_change_failed'); }
                finally { busy = false; render(); }
            });
            banner.append(panelIcon(doc, 'lock'), copy, upgrade);
        }
    }

    list.addEventListener('keydown', event => {
        if ( ! ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ) return;
        const cards = [...list.querySelectorAll('button:not(:disabled)')];
        const current = cards.indexOf(doc.activeElement);
        if ( current < 0 ) return;
        event.preventDefault();
        const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
            : (current + direction + cards.length) % cards.length;
        for ( const card of cards ) card.tabIndex = -1;
        cards[index].tabIndex = 0;
        cards[index].focus();
    });

    async function refresh () {
        status.textContent = text('compute_loading');
        try {
            const result = await getShapes();
            if ( ! Array.isArray(result) ) throw new Error('invalid shapes');
            shapes = result;
            status.textContent = shapes.length ? '' : text('compute_no_shapes');
        } catch {
            shapes = [];
            status.textContent = text('compute_load_failed');
        }
        render();
    }
    return { element: section, ready: refresh(), refresh };
}
