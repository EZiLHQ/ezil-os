// session.js — EZiL-authored. Local-only replacement for Puter's `puter.kv`.
//
// LOCAL CODE ONLY: upstream Puter persists shell preferences through ~40
// `puter.kv.*` calls against its cloud backend. None of that backend exists
// here, so every preference the shell keeps is browser-local. This module is
// the single seam that replaces it.
//
// Wave 0 scaffold: namespacing + a safe localStorage wrapper only. Later waves
// add the per-preference accessors as the Puter call sites are ported.

const NS = 'ezil-os:';

/** localStorage can throw (Safari private mode, disabled storage, quota). */
function storage() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

export function get(key, fallback = null) {
    const s = storage();
    if (!s) return fallback;
    try {
        const raw = s.getItem(NS + key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function set(key, value) {
    const s = storage();
    if (!s) return false;
    try {
        s.setItem(NS + key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

export function del(key) {
    const s = storage();
    if (!s) return false;
    try {
        s.removeItem(NS + key);
        return true;
    } catch {
        return false;
    }
}

export default { get, set, del };
