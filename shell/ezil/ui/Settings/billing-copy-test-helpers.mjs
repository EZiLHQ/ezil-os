// Keep the ban list intact. Only these approved resource-use phrases are exempt.
export const honestyBans = /\bfast\b|speed|in\s+seconds|ready\s+computer|lightning|blazing|Most popular|ram is kept|memory is preserved|processes (are )?kept|processes survive|keeps? running after/i;
export function v3CopyForAudit (text, { faq = false } = {}) {
    const copy = text.replaceAll('Bigger computers use your monthly time faster', '')
        .replaceAll('uses time 2× faster', '').replaceAll('uses time 4× faster', '')
        .replaceAll('Why do bigger computers use time faster?', '');
    return faq ? copy.replaceAll('about 500 standard-hours a month on Premium', '') : copy;
}
