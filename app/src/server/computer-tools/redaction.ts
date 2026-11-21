/**
 * Secret redaction for the stored terminal-command prefix (contract §5.4: "command_sha256
 * plus a secret-redacted prefix ≤120 chars"). The FULL command is never stored or logged —
 * only its sha256 and this redacted, bounded prefix.
 *
 * The redaction patterns are ported from the openclaw-agent-mcp operator terminal tool
 * (`infra/openclaw-agent-mcp/src/terminalCommand.mjs` `redactSecrets`, lines 30-45). Unlike
 * that tool, this port does NOT scan the host `process.env` by default: the OS app's own
 * environment holds OS secrets that have nothing to do with a user's command, so comparing
 * against them would neither help nor be meaningful here. A caller may still pass known
 * secret values explicitly. The full string is redacted BEFORE truncation, so a secret that
 * straddles the 120-char boundary cannot survive by being cut in half.
 */

/** Redact secret-shaped substrings from `text`. `knownSecrets` are exact values to strip. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
    if (!text) return text;
    let out = String(text);
    const values = knownSecrets
        .flatMap((v) => v.split(','))
        .map((v) => v.trim())
        .filter((v) => v.length >= 8)
        .sort((a, b) => b.length - a.length);
    for (const v of values) out = out.split(v).join('<redacted>');
    return out
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted private key>')
        .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '<redacted>')
        .replace(/\b(?:ABSK|bedrock-api-key-)[A-Za-z0-9+/=_-]{20,}/g, '<redacted>')
        .replace(/\b(AWS_(?:BEARER_TOKEN_BEDROCK|BEDROCK_KEY))([\\"']*\s*[:=]\s*[\\"']*)[^\s"',;\\]+/g, '$1$2<redacted>')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 <redacted>')
        .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S+/g, '$1=<redacted>');
}

/** The ≤120-char, secret-redacted command prefix stored in the audit for a terminal command. */
export function commandPrefix(command: string, knownSecrets: readonly string[] = []): string {
    return redactSecrets(command, knownSecrets).slice(0, 120);
}
