export function validateGrant(packet, repo, now = Date.now()) {
    const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!exact(packet, ['version', 'binding', 'identity', 'git']) || packet.version !== 1
        || !exact(packet.binding, ['projectId','repositoryId','canonicalURL','ref','bindingVersion'])
        || !uuid.test(packet.binding.projectId) || !uuid.test(packet.binding.repositoryId)
        || packet.binding.canonicalURL !== repo || !/^[a-f0-9]{64}$/.test(packet.binding.bindingVersion)
        || typeof packet.binding.ref !== 'string' || packet.binding.ref.length > 255 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(packet.binding.ref)
        || packet.binding.ref.includes('..') || packet.binding.ref.includes('//') || packet.binding.ref.endsWith('/')
        || packet.binding.ref.split('/').some(p => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))
        || !exact(packet.identity, ['issuer','subject']) || packet.identity.issuer !== 'https://id.ezil.work/'
        || typeof packet.identity.subject !== 'string' || !packet.identity.subject || packet.identity.subject.length > 255
        || !exact(packet.git, ['username','token','expiresAt','scope']) || packet.git.username !== 'ezil' || packet.git.scope !== 'read'
        || typeof packet.git.token !== 'string' || !/^egg_[A-Za-z0-9._~-]+$/.test(packet.git.token) || packet.git.token.length > 8192
        || typeof packet.git.expiresAt !== 'string' || !Number.isFinite(Date.parse(packet.git.expiresAt))
        || Date.parse(packet.git.expiresAt) <= now || Date.parse(packet.git.expiresAt) > now + 300000) throw new Error('repo_not_authorized');
    return packet;
}
