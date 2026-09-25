# Binding approved project directories

`mounts.ts` supplies the Linux host's directory binding primitive. It does not
start containers or create project grants. The authenticated execution driver
must derive source components from owned computer/installation/project IDs,
check the data-volume marker, and use only approved mount destinations.

The host runs as root, with util-linux `mount` and `umount` at `/bin`. Its data
and staging roots must be provisioned below root-owned directories that apps
cannot rename or write. Ancestor symlinks and writable host roots are refused.
User projects may be writable; opening their components uses `O_NOFOLLOW` and
directory descriptors, with a same-device check. A held descriptor continues
to identify the selected directory if the original path is renamed or replaced
with a link. Cross-filesystem submounts are outside this adapter.

The host binds that descriptor into a fresh, root-owned staging slot using
`mount --no-canonicalize --bind /proc/self/fd/3 ...`. Explicit descriptor
inheritance and disabling util-linux's canonicalization are necessary: calling
`realpath` would reopen the race. The staged bind is private, `nosuid,nodev`,
and read-only when requested. Docker receives the stable staging path instead
of the source pathname or a descriptor that could be reused after a crash.
The stage must be in the Docker daemon's mount namespace. Applications never
receive the staging root, Docker socket, or mount capabilities.

The consumer owns each stage until every consuming container is observed
removed. Only then may it call `release()`. Failed unmounts are not hidden with
lazy or forced detachment, and cleanup never recursively deletes a stage.
Name collisions do not adopt or remove an existing mount. The execution driver
must reconcile abandoned stages and containers using host-owned records; it
must not infer ownership solely from an untrusted path or automatically restart
old containers.

Run the package and real Linux/Docker checks locally:

```sh
npm --prefix supervisor ci --ignore-scripts
docker pull --platform linux/amd64 node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
bash tools/test.sh supervisor --linux-mounts
```

The explicit Linux suite requires local Docker and uses a privileged **test
host** with no network, a 64 MiB loopback ext4 disk, and shared mount propagation.
Its app reader is unprivileged with dropped capabilities, a read-only root,
no network or Docker socket, and memory/process limits. It
replaces a selected path with a symlink after opening it and before mounting,
then asks the actual Docker daemon to start a reader. It checks the selected
inode, durable writes, read-only rejection, traversal/symlink rejection, and
collision-safe cleanup. Test containers, binds, loop attachment, and disk file
are cleaned up; an empty uniquely named `/run/ezil-mount-test-*` directory can
remain on the Docker host. CI runs this suite explicitly; unavailable Docker
or missing images fail instead of being counted as a pass.

This proves local Linux mount behavior. It does not prove EBS attachment,
single-writer fencing between EC2 instances, Docker lifecycle reconciliation,
production app routing, or marketplace readiness.
