import { billingEnabled, text } from './text.js';

// The host supplies compute.shapes and the shape-change mutation. Eligibility
// here is presentation only; the server must check it again on start/claim.
export function mountComputeSize (container, {
    config, getShapes, getComputer, changeShape, confirmChange, onUpgrade,
} = {}) {
    if ( ! billingEnabled(config) || ! container || ! getShapes ) return null;
    const doc = container.ownerDocument;
    const section = doc.createElement('section');
    section.dataset.role = 'compute-size';
    const title = doc.createElement('h3');
    title.textContent = text('compute_size');
    const description = doc.createElement('p');
    description.textContent = text('compute_virtual_cpus');
    const list = doc.createElement('div');
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    section.append(title, description, list, status);
    container.append(section);
    let busy = false;
    let shapes = [];

    function render () {
        list.replaceChildren();
        for ( const shape of shapes ) {
            const row = doc.createElement('div');
            row.className = 'ezil-settings-row';
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'ezil-settings-btn';
            button.dataset.shape = shape.id;
            button.textContent = text('compute_shape', shape);
            button.disabled = busy || shape.eligible !== true || ! changeShape || ! confirmChange || ! getComputer?.()?.id;
            row.append(button);
            if ( shape.eligible !== true ) {
                const reason = doc.createElement('span');
                reason.textContent = shape.reason || text('compute_ineligible');
                button.title = reason.textContent;
                row.append(reason);
            }
            button.addEventListener('click', async event => {
                if ( button.disabled || busy || event.detail > 1 ) return;
                const computer = getComputer?.();
                if ( ! computer?.id ) return;
                busy = true;
                render();
                try {
                    const confirmed = await confirmChange({ computer, shape, message: text('compute_restart_warning') });
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
            list.append(row);
        }
        if ( shapes.some(shape => shape.eligible !== true) ) {
            const upgrade = doc.createElement('button');
            upgrade.type = 'button';
            upgrade.className = 'ezil-settings-btn';
            upgrade.dataset.action = 'upgrade';
            upgrade.textContent = text('compute_upgrade');
            upgrade.disabled = busy || ! onUpgrade;
            upgrade.addEventListener('click', async event => {
                if ( upgrade.disabled || busy || event.detail > 1 ) return;
                busy = true;
                render();
                try { await onUpgrade(); await refresh(); }
                catch { status.textContent = text('compute_change_failed'); }
                finally { busy = false; render(); }
            });
            list.append(upgrade);
        }
    }

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
