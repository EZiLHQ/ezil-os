// close-confirm.js — EZiL-authored. Native modality keeps focus above the
// full-bleed iframe without changing UIWindow's close lifecycle (UIWindow.js:3885).
const SKIP_KEY = 'ezil:close-confirm:skip';
let description_id = 0;

export function should_confirm ({ shared, skip }) {
    return !shared && !skip;
}

/** @returns {Promise<'close'|'minimize'|'cancel'>} */
export async function confirm_close ({ shared }) {
    let skip = false;
    // Storage can throw even on property access in privacy-restricted embeds.
    // Failure must ask, never silently consent (FEEDBACK-CONTROLS-CONTRACT.md:72).
    try { skip = window.localStorage.getItem(SKIP_KEY) === '1'; } catch {}
    if ( !should_confirm({ shared, skip }) ) return 'close';

    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'ezil-close-confirm';
    dialog.setAttribute('aria-label', 'Close Browser?');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2');
    heading.textContent = 'Close Browser?';
    const message = document.createElement('p');
    message.textContent = 'Your computer keeps running about a minute, then saves files and stops. Unsaved changes inside apps may be lost.';
    // Each open owns its description, so concurrent desktop windows cannot
    // accidentally announce a different dialog's text.
    message.id = `ezil-close-description-${++description_id}`;
    dialog.setAttribute('aria-describedby', message.id);
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    label.append(checkbox, document.createTextNode("Don't ask again"));
    const actions = document.createElement('div');
    actions.className = 'ezil-close-confirm-actions';
    const minimize = document.createElement('button');
    minimize.type = 'button';
    minimize.autofocus = true;
    minimize.textContent = 'Minimise instead';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    actions.append(minimize, close);
    dialog.append(heading, message, label, actions);
    document.body.appendChild(dialog);

    return new Promise(resolve => {
        let finished = false;
        const teardown = () => finish('cancel');
        const finish = choice => {
            // Native close and shell teardown can follow the same click;
            // consent must be recorded only for the first completed action.
            if ( finished ) return;
            finished = true;
            window.removeEventListener('ezil:teardown', teardown);
            // Only confirming Close consents to skipping later confirmations;
            // Escape and Minimise must not turn a future red click destructive.
            if ( choice === 'close' && checkbox.checked ) {
                try { window.localStorage.setItem(SKIP_KEY, '1'); } catch {}
            }
            dialog.remove();
            previous?.focus();
            resolve(choice);
        };
        minimize.addEventListener('click', () => finish('minimize'), { once: true });
        close.addEventListener('click', () => finish('close'), { once: true });
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            finish('cancel');
        }, { once: true });
        dialog.addEventListener('close', () => finish('cancel'), { once: true });
        window.addEventListener('ezil:teardown', teardown);
        try {
            dialog.showModal();
            minimize.focus();
        } catch {
            // If modality is unavailable, keep the window and its yellow exit;
            // failure to show the warning is not permission to close it.
            finish('cancel');
        }
    });
}
