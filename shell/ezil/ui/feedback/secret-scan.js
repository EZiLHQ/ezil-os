// secret-scan.js — EZiL-authored. Advisory only; never sends or retains text.
// Kinds and offsets let the UI warn without repeating a possible secret.
const PATTERNS = [
    ['JWT', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
    ['sk- token', /\bsk-[A-Za-z0-9_-]+/g],
    ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/g],
    ['GitHub token', /\bghp_[A-Za-z0-9]+/g],
    ['Slack token', /\bxox[a-z]?-[A-Za-z0-9-]+/gi],
    ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi],
    ['auth cookie', /__Host-ezil-os-auth\b|\bsb-[A-Za-z0-9_-]+-auth-token\b/g],
    ['email address', /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g],
];

/** @param {string} text @returns {Array<{kind:string,index:number}>} */
export function scan (text) {
    if ( typeof text !== 'string' ) return [];
    const matches = [];
    for ( const [kind, pattern] of PATTERNS ) {
        for ( const match of text.matchAll(new RegExp(pattern)) ) matches.push({ kind, index: match.index });
    }
    return matches.sort((a, b) => a.index - b.index);
}
