#!/usr/bin/env bash
set -euo pipefail
# The workflow serializes publishers globally. Only a genuine missing manifest
# permits a build; auth/network failures must never become an overwrite request.
exists() {
  local out
  if out="$(docker manifest inspect "$1" 2>&1)"; then return 0; fi
  if grep -qiE 'unauthorized|denied|forbidden' <<<"$out"; then printf '%s\n' "$out" >&2; exit 1; fi
  if grep -qiE 'manifest unknown|no such manifest' <<<"$out"; then return 1; fi
  printf '%s\n' "$out" >&2
  exit 1
}
digest() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' | jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))'
}
continuity="$(jq -r .continuity image-plan.json)"
if ! exists "$continuity"; then
  docker build -t "$continuity" worker/neko
  docker push "$continuity"
  echo "continuity_built=true" >> "$GITHUB_OUTPUT"
fi
continuity_digest="$(digest "$continuity")"
base="$(jq -r .base image-plan.json)"
overlay="$(jq -r .overlay image-plan.json)"
desktop="$(jq -r .desktop image-plan.json)"
if ! exists "$base"; then
  NEKO_IMAGE_TAG="$base" docker/neko/build.sh
  docker push "$base"
  echo "base_built=true" >> "$GITHUB_OUTPUT"
fi
base_digest="$(digest "$base")"
if ! exists "$overlay"; then
  docker build --build-arg "NEKO_CONTINUITY_IMAGE=${continuity%:*}@$continuity_digest" --build-arg "BASE_NEKO_IMAGE=${base%:*}@$base_digest" -t "$overlay" -f worker/assets/neko-branding/Dockerfile worker/assets/neko-branding
  docker push "$overlay"
  echo "overlay_built=true" >> "$GITHUB_OUTPUT"
fi
overlay_digest="$(digest "$overlay")"
if ! exists "$desktop"; then
  docker build --build-arg "NEKO_IMAGE=${overlay%:*}@$overlay_digest" \
    --label "org.opencontainers.image.revision=$EZIL_DEPLOY_SHA" -t "$desktop" -f worker/Dockerfile worker
  docker push "$desktop"
  echo "desktop_built=true" >> "$GITHUB_OUTPUT"
fi
desktop_digest="$(digest "$desktop")"
docker pull "${desktop%:*}@$desktop_digest"
test "$(docker image inspect "${desktop%:*}@$desktop_digest" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EZIL_DEPLOY_SHA"
jq --arg c "$continuity_digest" --arg b "$base_digest" --arg o "$overlay_digest" --arg d "$desktop_digest" \
  '. + {continuity_digest:$c,base_digest:$b,overlay_digest:$o,desktop_digest:$d}' image-plan.json > published-images.json
echo "desktop_ref=${desktop%:*}@$desktop_digest" >> "$GITHUB_OUTPUT"
for key in continuity_digest base_digest overlay_digest desktop_digest; do
  echo "$key=${!key}" >> "$GITHUB_OUTPUT"
done
