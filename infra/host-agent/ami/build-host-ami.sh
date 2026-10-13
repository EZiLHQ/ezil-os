#!/usr/bin/env bash
# EZiL AWS computer host AMI build (I4). Runs ON THE BUILD INSTANCE as root (an EC2
# Image Builder component calls it; see imagebuilder-component.yaml). It makes no AWS API
# calls and bakes in no secrets: the tunnel token and control key arrive per epoch at
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
#   ENROLL_URL                https://<app>/api/internal/computers/enroll (not secret)
# Optional:
#   PREVIOUS_DESKTOP_IMAGE_REF / PREVIOUS_DESKTOP_IMAGE_ID   keep the N-1 lower for R4 rebase
set -euo pipefail
: "${AGENT_SRC:?}" "${DESKTOP_IMAGE_REF:?}" "${DESKTOP_IMAGE_ID:?}" "${CLOUDFLARED_VERSION:?}" "${ENROLL_URL:?}"
CLOUDFLARED_SHA256="${CLOUDFLARED_SHA256:?CLOUDFLARED_SHA256 is required (no default; copy it from the reviewed release)}"
[[ "$CLOUDFLARED_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "CLOUDFLARED_SHA256 must be 64 hex chars" >&2; exit 1; }
[[ "$DESKTOP_IMAGE_REF" == *@sha256:* ]] || { echo "DESKTOP_IMAGE_REF must pin a digest" >&2; exit 1; }
[[ "$ENROLL_URL" == https://* ]] || { echo "ENROLL_URL must be https" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# 1. host packages (Ubuntu archive; versions recorded in the build log)
apt-get update -q
apt-get install -y -q runc python3 util-linux e2fsprogs apparmor apparmor-utils jq iproute2 iptables nvme-cli
dpkg-query -W runc python3 util-linux apparmor | tee /etc/ezil-host-packages.txt

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
jq -n --arg u "$ENROLL_URL" '{enrollUrl: $u, networkMode: "veth-nat"}' > /etc/ezil-host/agent.json
install -d -m 0700 /var/lib/ezil-host

# 4. desktop image rootfs by digest -> lower; record lowerImageDigest
apt-get install -y -q docker.io
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
apt-get purge -y -q docker.io && rm -rf /var/lib/docker /var/lib/containerd

# 5. user data is data, not a script; cloud-init must not run or keep it
cat > /etc/cloud/cloud.cfg.d/99-ezil-host.cfg <<'CFG'
allow_userdata: false
CFG

# 6. enable the host chain
systemctl daemon-reload
systemctl enable ezil-host.target ezil-lease.service ezil-guard.service ezil-host-clean.service \
  ezil-overlay.service ezil-desktop.service ezil-enroll.service ezil-cloudflared.service ezil-agent.service
echo "ezil host AMI build complete: lower ${DESKTOP_IMAGE_ID}"
