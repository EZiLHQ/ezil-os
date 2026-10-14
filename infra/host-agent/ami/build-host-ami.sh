#!/usr/bin/env bash
# EZiL AWS computer host AMI build (I4). Runs ON THE BUILD INSTANCE as root (an EC2
# Image Builder component calls it; see imagebuilder-component.yaml). ECR pulls use
# the build instance role. It bakes in no secrets: the tunnel token and control key arrive per epoch at
# enrollment (C-6), the nonce through user data.
#
# Required inputs (environment):
#   AGENT_SRC                 checkout of infra/host-agent at the reviewed commit
#   DESKTOP_IMAGE_REF         desktop image by DIGEST: <registry>/<repo>@sha256:<manifest>
#   DESKTOP_IMAGE_ID          expected image ID (config digest, sha256:…) = lowerImageDigest
#   CLOUDFLARED_VERSION       pinned release, e.g. 2025.x.y (reviewed)
#   CLOUDFLARED_SHA256        sha256 of cloudflared-linux-amd64 for that release, copied
#                             from the reviewed release notes. NO DEFAULT: the build fails
#                             without it, and fails if the download does not match.
#   ENROLL_URL                https://os.ezil.work/api/compute/aws/enroll (not secret)
# Optional:
#   PREVIOUS_DESKTOP_IMAGE_REF / PREVIOUS_DESKTOP_IMAGE_ID   keep the N-1 lower for R4 rebase
set -euo pipefail
: "${AGENT_SRC:?}" "${DESKTOP_IMAGE_REF:?}" "${DESKTOP_IMAGE_ID:?}" "${CLOUDFLARED_VERSION:?}" "${ENROLL_URL:?}"
CLOUDFLARED_SHA256="${CLOUDFLARED_SHA256:?CLOUDFLARED_SHA256 is required (no default; copy it from the reviewed release)}"
[[ "$CLOUDFLARED_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "CLOUDFLARED_SHA256 must be 64 hex chars" >&2; exit 1; }
[[ "$DESKTOP_IMAGE_REF" == *@sha256:* ]] || { echo "DESKTOP_IMAGE_REF must pin a digest" >&2; exit 1; }
[[ "$ENROLL_URL" == https://* ]] || { echo "ENROLL_URL must be https" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# 1. host packages, PINNED (Ubuntu 24.04 "noble"). The defaults are the exact versions the
#    I4 tests ran against. A pin that is no longer in the archive FAILS the build: bump it
#    in review, or set UBUNTU_SNAPSHOT (snapshot.ubuntu.com, e.g. 20261013T000000Z) to
#    install from a fixed point in time. Overridable only by explicit environment.
. /etc/os-release
[ "${VERSION_CODENAME:-}" = noble ] || { echo "base image must be Ubuntu 24.04 (noble), got ${VERSION_CODENAME:-?}" >&2; exit 1; }
PINS=(
  "runc=${PIN_RUNC:-1.3.4-0ubuntu1~24.04.1}"
  "python3=${PIN_PYTHON3:-3.12.3-0ubuntu2.1}"
  "util-linux=${PIN_UTIL_LINUX:-2.39.3-9ubuntu6.6}"
  "e2fsprogs=${PIN_E2FSPROGS:-1.47.0-2.4~exp1ubuntu4.1}"
  "apparmor=${PIN_APPARMOR:-4.0.1really4.0.1-0ubuntu0.24.04.6}"
  "jq=${PIN_JQ:-1.7.1-3ubuntu0.24.04.2}"
  "iproute2=${PIN_IPROUTE2:-6.1.0-1ubuntu6.3}"
  "iptables=${PIN_IPTABLES:-1.8.10-3ubuntu2}"
  "nvme-cli=${PIN_NVME_CLI:-2.8-1ubuntu0.1}"
)
SNAP=(); [ -n "${UBUNTU_SNAPSHOT:-}" ] && SNAP=(--snapshot "$UBUNTU_SNAPSHOT")
apt-get update -q "${SNAP[@]}"
apt-get install -y -q --no-install-recommends "${SNAP[@]}" "${PINS[@]}"
apt-mark hold runc python3 util-linux e2fsprogs apparmor jq iproute2 iptables nvme-cli >/dev/null
dpkg-query -W runc python3 util-linux e2fsprogs apparmor jq iproute2 iptables nvme-cli | tee /etc/ezil-host-packages.txt

# 2. cloudflared, pinned and checksum-verified
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/cloudflared" \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64"
echo "${CLOUDFLARED_SHA256}  $tmp/cloudflared" | sha256sum -c -
install -m 0755 -o root -g root "$tmp/cloudflared" /usr/local/bin/cloudflared
rm -rf "$tmp"

# 3. agent, security profiles, units, config template (no secrets)
install -d -m 0755 /opt/ezil-host /etc/ezil-host
cp -a "$AGENT_SRC/bin" "$AGENT_SRC/lib" /opt/ezil-host/
find /opt/ezil-host -name __pycache__ -prune -exec rm -rf {} +
install -m 0644 "$AGENT_SRC/security/seccomp.json" /etc/ezil-host/seccomp.json
install -m 0644 "$AGENT_SRC/security/apparmor-ezil-desktop" /etc/apparmor.d/ezil-desktop
apparmor_parser -r -W /etc/apparmor.d/ezil-desktop
install -m 0644 "$AGENT_SRC"/systemd/* /etc/systemd/system/
# iceMode relay: no inbound rule, so the streamed desktop needs the Worker's TURN relay config
jq -n --arg u "$ENROLL_URL" '{enrollUrl: $u, networkMode: "veth-nat", iceMode: "relay"}' > /etc/ezil-host/agent.json
install -d -m 0700 /var/lib/ezil-host

# 4. desktop image rootfs by digest -> lower; record lowerImageDigest
# The pinned Ubuntu helper uses the instance role through IMDSv2; no CLI or
# static credentials are needed. Apt verifies the package SHA-256 against its
# signed archive metadata, just as for the other pinned packages above.
apt-get install -y -q --no-install-recommends "${SNAP[@]}" "docker.io=${PIN_DOCKER_IO:-29.1.3-0ubuntu3~24.04.2}" "amazon-ecr-credential-helper=${PIN_ECR_HELPER:-0.7.1-1ubuntu0.24.04.3}"
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG AWS_ECR_DISABLE_CACHE=true
export AWS_ECR_CACHE_DIR="$DOCKER_CONFIG/ecr"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '{"credsStore":"ecr-login"}\n' > "$DOCKER_CONFIG/config.json"
extract() { # extract <ref@digest> <expected image id>
  docker pull "$1"
  local id; id="$(docker image inspect --format '{{.Id}}' "$1")"
  [ "$id" = "$2" ] || { echo "image id $id != expected $2" >&2; exit 1; }
  local dir="/var/lib/ezil/lowers/${2#sha256:}" c; c="$(docker create "$1" /bin/true)"
  install -d -m 0755 "$dir"
  docker export "$c" | tar -C "$dir" --numeric-owner --xattrs --xattrs-include='*' -xpf -
  docker rm "$c" >/dev/null
  docker image inspect "$1" | jq '{Env: .[0].Config.Env, WorkingDir: .[0].Config.WorkingDir}' > "$dir.image-config.json"
}
extract "$DESKTOP_IMAGE_REF" "$DESKTOP_IMAGE_ID"
echo "$DESKTOP_IMAGE_ID" > /etc/ezil-host/lower-image-digest
cp "/var/lib/ezil/lowers/${DESKTOP_IMAGE_ID#sha256:}.image-config.json" /etc/ezil-host/image-config.json
if [ -n "${PREVIOUS_DESKTOP_IMAGE_REF:-}" ]; then extract "$PREVIOUS_DESKTOP_IMAGE_REF" "${PREVIOUS_DESKTOP_IMAGE_ID:?}"; fi
apt-get purge -y -q docker.io amazon-ecr-credential-helper
rm -rf /var/lib/docker /var/lib/containerd "$DOCKER_CONFIG"
trap - EXIT
unset DOCKER_CONFIG AWS_ECR_DISABLE_CACHE AWS_ECR_CACHE_DIR

# 5. user data is data, not a script: cloud-init must not act on it. cloud-init still
#    CACHES it (instances/<id>/user-data.txt*, obj.pkl, /run/cloud-init/
#    instance-data-sensitive.json); the agent wipes those copies after enrollment
#    (agent.json userDataCopies). Remove anything baked from the build instance's own boot.
cat > /etc/cloud/cloud.cfg.d/99-ezil-host.cfg <<'CFG'
allow_userdata: false
CFG
cloud-init clean --logs --seed

# 6. the container's DNS resolver (veth-nat): systemd-resolved also answers on the host
#    end of the veth, 10.200.0.1:53 (the agent allows only that from the container).
install -d /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNSStubListenerExtra=10.200.0.1\n' > /etc/systemd/resolved.conf.d/90-ezil-container.conf

# 7. enable the host chain
systemctl daemon-reload
# The target pulls in the services through Wants/Requires; services remain static.
systemctl enable ezil-host.target
echo "ezil host AMI build complete: lower ${DESKTOP_IMAGE_ID}"
