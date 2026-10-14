"""Host-agent configuration. Baked into the AMI at /etc/ezil-host/agent.json; no secrets.

Every path the agent touches comes from here, so tests can point the real code at a
scratch directory, a loop device and stub endpoints without any test-only branches.
"""
import json
import os

DEFAULTS = {
    "dataMount": "/srv/ezil-data",
    "stateDir": "/var/lib/ezil-host",          # host-only, 0700: tunnel token, control key
    "runDir": "/run/ezil-host",                # tmpfs: bundle, stamps, control socket
    "lowersDir": "/var/lib/ezil/lowers",       # <lowersDir>/<digest-hex>/ = image rootfs
    "lowerDigestFile": "/etc/ezil-host/lower-image-digest",
    "imageConfigFile": "/etc/ezil-host/image-config.json",
    "seccompProfile": "/etc/ezil-host/seccomp.json",
    "apparmorProfile": "ezil-desktop",
    "deviceByIdDir": "/dev/disk/by-id",
    "imdsUrl": "http://169.254.169.254",
    "enrollUrl": None,                         # https://<app>/api/internal/computers/enroll
    "caFile": None,                            # None = system trust store
    "tlsServerName": None,                     # only for unix:// test endpoints
    "runcBin": "/usr/sbin/runc",
    "cloudflaredBin": "/usr/local/bin/cloudflared",
    "containerId": "ezil-desktop",
    "netnsName": "ezil-desktop",
    "networkMode": "none",                     # none | veth-nat (see netns.py)
    "cgroupsPath": "system.slice:ezil:desktop",
    "pidsLimit": 4096,
    "cpuQuota": 200000,
    "memoryLimit": 8589934592,
    "idle": {"inactivitySeconds": 600, "load1Busy": 0.5, "intervalSeconds": 30,
             "flushTimeoutSeconds": 120},
    "shutdownCmd": ["/usr/sbin/shutdown", "-h", "now"],
    "stopWarnSeconds": 60,
    # Host edge (gateway contract GW-2/GW-3): cloudflared's only ingress target. It forwards
    # verified requests to the desktop at edgeUpstreamHost on the edgePorts the CF route exposes.
    "edgeBind": "127.0.0.1",
    "edgePort": 18080,
    "edgeUpstreamHost": "10.200.0.2",
    "edgePorts": [8181, 8080, 3002, 8443],
    # cloud-init's cached copies of user data (they hold the nonce); globs; wiped after use.
    # obj.pkl is cloud-init's pickled datasource cache (it embeds the raw user data); it is
    # a cache that cloud-init rebuilds when missing. instance-data-sensitive.json is the
    # root-only instance-data dump. See README "cloud-init" for what is verified.
    "userDataCopies": ["/var/lib/cloud/instances/*/user-data.txt", "/var/lib/cloud/instances/*/user-data.txt.i",
                       "/var/lib/cloud/instances/*/obj.pkl", "/var/lib/cloud/instance/obj.pkl",
                       "/var/lib/cloud/instance/user-data.txt", "/var/lib/cloud/instance/user-data.txt.i",
                       "/run/cloud-init/instance-data-sensitive.json"],
}


class Config(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e

    def path(self, *parts):
        return os.path.join(*parts)


def load(path=None):
    path = path or os.environ.get("EZIL_HOST_CONFIG", "/etc/ezil-host/agent.json")
    cfg = Config(json.loads(json.dumps(DEFAULTS)))
    with open(path, encoding="utf-8") as f:
        user = json.load(f)
    for k, v in user.items():
        if k == "idle":
            cfg["idle"].update(v)
        else:
            cfg[k] = v
    return cfg


def host_digest(cfg):
    with open(cfg.lowerDigestFile, encoding="utf-8") as f:
        d = f.read().strip()
    if not d.startswith("sha256:") or len(d) != 71:
        raise SystemExit("lower image digest file is malformed")
    return d


def lower_dir(cfg, digest):
    return os.path.join(cfg.lowersDir, digest.split(":", 1)[1])
