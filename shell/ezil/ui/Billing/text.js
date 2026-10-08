import en from '../../../src/i18n/translations/en.js';

export function text (key, values = {}) {
    const translated = typeof globalThis.i18n === 'function' ? globalThis.i18n(key) : null;
    const copy = translated && translated !== key ? translated : en.dictionary[key] ?? key;
    return copy.replace(/\{\{(\w+)\}\}/g, (match, name) => String(values[name] ?? match));
}

export function billingReason (kind, body) {
    return text(kind === 'provider' && body?.error?.charge === 'none'
        ? 'billing_reason_provider_none' : `billing_reason_${kind}`);
}

export function billingEnabled (config) {
    return config?.WALLET_V2_ENABLED === true;
}
