/**
 * THE REDACTION CHOKE POINT.
 *
 * 🔴 This module is a HARD REQUIREMENT, not a nicety. `ARCHITECTURE.md` §3.3a
 * (WRK-01) in the EZiL-Works repo moved the collection boundary for browser
 * work but held `secrets` on the never-collected list: the trail records THAT
 * a credential was created and where, never the value. A browser automation
 * surface that echoes what it typed into `input[type=password]` — in a `/type`
 * response, in an accessibility snapshot, in `/get_text`, in a console line,
 * in a request body captured by `/network` — writes the value straight into an
 * agent transcript, which is exactly the artefact that outlives the session.
 *
 * ── Why ONE function, applied ONCE, at the response boundary ─────────────────
 * Because a guard that lives in six places cannot be mutation-proved. If the
 * snapshot builder masked passwords AND this ran, deleting either one would
 * leave the test green and the reviewer with no way to tell which line was
 * load-bearing. So the builders emit what they see, this is the only thing
 * standing between them and the socket, and `redaction.test.mjs` proves it by
 * deleting it. See `worker/sidecar/README.md` for the mutation procedure.
 *
 * The one thing this cannot do is a PNG: a password is not text in an image.
 * That is a genuinely different mechanism (Playwright's `mask`), it lives in
 * `verbs.mjs`'s screenshot handler, and it has its own separate proof — a
 * capture of a 4-character password and a 20-character one must be BYTE
 * IDENTICAL, because a masked field renders the same box either way while an
 * unmasked one renders a different number of dots.
 */

/** What a redacted value is replaced with. Fixed so a caller can recognise it. */
export const REDACTED = '[redacted]';

/**
 * Minimum length of a value this will act on.
 *
 * A one- or two-character "secret" would turn every response into confetti —
 * redacting `a` rewrites half the English language. Real credentials are
 * longer than this, and a caller who typed `ab` into a password box has not
 * created a credential worth protecting at the cost of destroying every other
 * response. Stated as a constant so the trade-off is visible rather than
 * buried in a comparison.
 */
export const MIN_SECRET_LENGTH = 3;

/**
 * Replace every occurrence of every known secret in `text`.
 *
 * Longest-first so a secret that contains another secret as a substring is
 * replaced whole rather than being shredded into `[redacted]abc`.
 */
export function redactSecrets (text, secrets) {
    if (typeof text !== 'string' || text.length === 0) return text;
    const usable = normaliseSecrets(secrets);
    if (usable.length === 0) return text;
    let out = text;
    for (const secret of usable) out = out.split(secret).join(REDACTED);
    return out;
}

/**
 * De-duplicate, drop anything too short to act on, and order longest-first.
 * Exported so the test can assert the ordering rule directly.
 */
export function normaliseSecrets (secrets) {
    if (!secrets) return [];
    const set = new Set();
    for (const s of secrets) {
        if (typeof s !== 'string') continue;
        if (s.length < MIN_SECRET_LENGTH) continue;
        set.add(s);
    }
    return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Deep-walk a JSON-shaped response payload and redact every string in it —
 * object values, array members and object KEYS alike. Keys matter: a captured
 * form post can land a credential in a key position, and a response that leaks
 * it there leaks it just as completely as one that leaks it in a value.
 *
 * Cycles are impossible in the payloads this serves (they are all freshly
 * built plain objects on their way to `JSON.stringify`), but the depth cap is
 * here anyway so a future verb cannot turn a leak guard into a stack overflow.
 */
export function redactDeep (value, secrets, depth = 0) {
    if (depth > 24) return value;
    const usable = normaliseSecrets(secrets);
    if (usable.length === 0) return value;
    return walk(value, usable, depth);
}

function walk (value, usable, depth) {
    if (depth > 24) return value;
    if (typeof value === 'string') return redactSecrets(value, usable);
    if (Array.isArray(value)) return value.map((v) => walk(v, usable, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[redactSecrets(k, usable)] = walk(v, usable, depth + 1);
        }
        return out;
    }
    return value;
}
