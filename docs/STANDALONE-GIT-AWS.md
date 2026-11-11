# Standalone Git on the owned AWS computer

Base: exact staging H `32d26a255bccc2f3f0e12eb4c427f7bdfad5ec8a`. Source lane only; deployment and host/AMI custody remain with the release owner.

The existing AWS edge exposes authenticated browser proxying and narrow control operations, but no ttyd, generic exec, or repository-open operation. This change adds one closed standalone Git operation over the existing gw1 tunnel and signed agent socket. It does not add a generic command, executable, root path, download URL, or script field.

1. OS verifies computer ownership, obtains the shared OAuth identity's exact standalone v2 grant, and mints Code using the selected computer's normal provider path. It re-reads the placement after minting. Public github.com opens retain their existing provider restriction.
2. Worker verifies the app's body-bound v2 claims. An AWS request must carry the standalone packet. The tunnel's computer, generation and lease epoch must match at admission and on every status poll; an absent/fenced/stale tunnel is refused without a Cloudflare fallback.
3. Worker sends exactly `{v:1, jobId, repositoryId, privatePacket, timeoutMs}` to `POST /__ezil/control/standalone-repo-open/<sha256(body)>`. gw1 binds the digest path and epoch. Edge compares the exact bounded Content-Length body before strict JSON parsing, then signs the same narrow request to the host agent.
4. Agent admits at most one operation on a running desktop, refusing stop/export/restart quarantine. Job and grant remain in memory, never on the data volume or a host request file. A repeated job ID reports that job; its token-free result expires after ten minutes. Unknown outcome quarantines further opens rather than deleting locks or user files.
5. Host executes only the reviewed public bootstrap and pinned Node CLI inside the existing runc desktop. Public bootstrap input contains no credential. The grant reaches the fixed in-container FD adapter on anonymous stdin and the reviewed supervisor/CLI through anonymous FD 3. It is absent from argv, environment, files and logs. The supervisor enforces the deadline, reaps descendants and preserves uncertain state.
6. CLI opens `/workspace/projects/<deterministic UUID>/repository`; Code opens only its parent wrapper. Existing origin/ref mismatches refuse, while local commits, dirty/index/untracked files survive reuse. Host matches the exact CLI output identity, provider repository ID, ref and folder. Worker binds the result to its one random job ID and validates the exact requested wrapper; it does not claim a second CLI identity attestation. The OAuth subject is not translated into a Works identity.

This requires a qualified host-agent rollout: current hosts return 404 for this new capability. No app/Worker-only change can manufacture an anonymous-FD execution channel through today's browser tunnel. Desktop image bytes need no change if the selected desktop already provides Python, Node >=22 and Git; otherwise the public bootstrap fails closed and the release owner must qualify that concrete image requirement. This source branch launches no AMI, image, host or lifecycle operation.

Admission performs only bounded readiness reads (mountpoint and runc state each <=500ms) while the lifecycle lock is held. Clone/bootstrap run outside that lock. Runtime enablement remains off by default in both app and Worker until the new host-agent capability is qualified. The branch includes reviewed registry capacity 28 support; no migration or unrelated U8/MCP source is required.

## Qualification and runtime custody

Both app and Worker require AWS_STANDALONE_REPO_OPEN_ENABLED explicitly enabled; Worker also requires its existing AWS routing gate. It stays off during app/Worker rollout and host AMI qualification. Runtime custody and the original user's resource remain with release owner 40003c71.

The AMI source archive is the complete committed infra/host-agent tree. The current installer copies bin and lib recursively (cp -a), including standalone_git_assets/{stage.py,supervise.py,pin.json}. An offline smoke test executes that exact copy line into a disposable install root, imports from an unrelated cwd, and compares helper/source hashes. It invokes no image build or external service.

Offline receipts prove the actual anonymous-pipe FD adapter and reviewed supervisor separately from the mocked runc exec call shape. The release owner must still observe the real runc stdin/FD3 boundary, Python/Node>=22/Git availability, bounded cancellation/reaping, exact wrapper and dirty reuse on the capped staging canary before enabling the capability. Failure stays closed; no alternate interpreter, arbitrary URL, unpinned executable or generic exec endpoint is accepted.

The host admission marker contains only its random job ID and remains after agent restart or unconfirmed cleanup. Recovery is a custody operation: establish that the owned in-container supervisor/descendants are gone and inspect CLI recovery state before clearing a marker. This feature never clears CLI locks, resets a checkout, deletes user files, or performs lifecycle recovery automatically.
