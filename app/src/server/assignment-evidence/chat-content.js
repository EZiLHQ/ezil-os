/** Only already-submitted or rendered assessment text reaches this boundary. */
export function assessmentChatContent(value) {
    const maxBytes = 16 * 1024;
    if (typeof value !== 'string' || value.length === 0 || !value.trim()) return { contentStatus: 'unavailable' };
    if (value.length > maxBytes || new TextEncoder().encode(value).length > maxBytes
        || new TextEncoder().encode(JSON.stringify(value)).length > 24 * 1024) return { contentStatus: 'over_limit' };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
        || /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)
        || /(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/]+:[^\s/]+@/i.test(value)
        || /(?:\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|(?:sk|rk|gh[pousr]|github_pat|xox[baprs]|ezk|ezg)[_-][A-Za-z0-9_=-]{8,})/i.test(value)
        || /\bBearer\s+[^\s'"`]{8,}/i.test(value)
        || /["']?(?:PASSWORD|PASSWD|API[_ -]?KEY|[A-Z0-9_]*TOKEN|[A-Z0-9_]*SECRET|AUTHORIZATION|COOKIE)["']?\s*[:=]\s*\S/i.test(value)) {
        return { contentStatus: 'withheld' };
    }
    return { contentStatus: 'captured', text: value };
}
