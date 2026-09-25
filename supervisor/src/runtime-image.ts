import type { Docker } from './docker.js';

/** Shared by preparation and launch: a tag or manifest digest alone does not
 * establish Linux/amd64 compatibility or absence of implicit data volumes. */
export async function inspectRuntimeImage(docker: Docker, reference: string): Promise<string> {
    const image = await docker.call<{ Id: string; Os: string; Architecture: string;
        RepoDigests: string[]; Config: { Volumes?: Record<string, unknown>; OnBuild?: unknown[] } }>(
        'GET', `/images/${encodeURIComponent(reference)}/json`);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Os !== 'linux' || image.Architecture !== 'amd64'
        || Object.keys(image.Config.Volumes ?? {}).length || image.Config.OnBuild?.length
        || (reference.startsWith('sha256:') ? image.Id !== reference : !image.RepoDigests?.includes(reference))) {
        throw new Error('unsupported_runtime_image');
    }
    return image.Id;
}
