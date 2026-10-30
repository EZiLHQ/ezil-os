#!/usr/bin/env bash
# Sourced before any build mutation; also exercised without Docker in offline tests.
validate_lower_inputs() {
    local ref_pattern='^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'
    local image_ref image_id
    for image_ref in "$DESKTOP_IMAGE_REF" "${PREVIOUS_DESKTOP_IMAGE_REF:-}"; do
        [[ -z "$image_ref" ]] && continue
        [[ ${#image_ref} -le 512 && "$image_ref" =~ $ref_pattern && "${image_ref#*.amazonaws.com/}" != *.amazonaws.com/* ]] || return 1
    done
    for image_id in "$DESKTOP_IMAGE_ID" "${PREVIOUS_DESKTOP_IMAGE_ID:-}"; do
        [[ -z "$image_id" ]] && continue
        [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    done
    [[ -n "$DESKTOP_IMAGE_REF" && -n "$DESKTOP_IMAGE_ID" ]] || return 1
    if [[ -n "${PREVIOUS_DESKTOP_IMAGE_REF:-}" || -n "${PREVIOUS_DESKTOP_IMAGE_ID:-}" ]]; then
        [[ -n "${PREVIOUS_DESKTOP_IMAGE_REF:-}" && -n "${PREVIOUS_DESKTOP_IMAGE_ID:-}" &&
           "${PREVIOUS_DESKTOP_IMAGE_REF%@*}" == "${DESKTOP_IMAGE_REF%@*}" &&
           "$PREVIOUS_DESKTOP_IMAGE_ID" != "$DESKTOP_IMAGE_ID" ]] || return 1
    fi
}
