import { classifyGatewayError } from './classify.js';
import { text } from './text.js';
import { billingIcon, injectBillingStyles } from './style-dialog.js';

// The chat adapter owns the feature gate and mounts this above its composer.
export function createComposerNotice ({ document: doc = globalThis.document, draft, onResend } = {}) {
    let element = null;
    let timer = null;
    let generation = 0;

    function hide () {
        generation++;
        clearInterval(timer);
        timer = null;
        if ( element ) element.hidden = true;
    }

    function show ({ status, body } = {}) {
        hide();
        const current = generation;
        let sending = false;
        const kind = classifyGatewayError(status, body);
        const hint = body?.error?.retryAfterSeconds ?? body?.retryAfterSeconds;
        const seconds = kind === 'retry_later' && Number.isFinite(hint) && hint > 0 ? Math.ceil(hint) : 0;
        const deadline = Date.now() + seconds * 1000;
        injectBillingStyles(doc);
        if ( ! element ) element = doc.createElement('div');
        element.className = `ezil-billing-bar${kind === 'retry_later' ? ' ezil-billing-bar-warning' : ''}`;
        element.hidden = false;
        const message = doc.createElement('span');
        message.className = 'ezil-billing-bar-message';
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'ezil-billing-button';
        retry.dataset.action = 'retry';
        retry.textContent = text('billing_bar_retry');
        const remaining = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        function update () {
            const left = remaining();
            const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
            if ( kind === 'retry_later' ) {
                message.textContent = status === 503 ? text('billing_bar_paused')
                    : text(left > 0 ? 'billing_bar_limit_countdown' : 'billing_bar_limit', { time });
                if ( status === 503 && left > 0 ) message.textContent += ` ${text('billing_bar_countdown', { time })}`;
                message.classList.add('ezil-billing-countdown');
            } else if ( kind === 'provider' ) {
                message.textContent = text(body?.error?.charge === 'none' ? 'billing_bar_provider_none' : 'billing_bar_provider_review');
            } else message.textContent = text('billing_bar_unknown');
            retry.disabled = left > 0 || sending || ! onResend;
            if ( left === 0 ) { clearInterval(timer); timer = null; }
        }
        retry.addEventListener('click', async event => {
            if ( event.detail > 1 || retry.disabled || remaining() > 0 || sending || current !== generation || element.hidden ) return;
            sending = true;
            update();
            try {
                await onResend(draft);
                if ( current === generation ) hide();
            } catch {
                if ( current === generation ) message.textContent = text('billing_bar_retry_failed');
            } finally {
                sending = false;
                if ( current === generation ) retry.disabled = remaining() > 0 || ! onResend;
            }
        });
        element.replaceChildren(billingIcon(doc, 'warning'), message, retry);
        update();
        if ( seconds > 0 ) timer = setInterval(update, 250);
        if ( ! element.isConnected ) doc.body.prepend(element);
        return true;
    }

    return {
        show, hide,
        get element () { return element; },
        get draft () { return draft; },
        destroy () { hide(); element?.remove(); element = null; },
    };
}
