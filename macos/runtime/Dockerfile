FROM ubuntu:24.04@sha256:69cecf4bbf72d2d44a9eef1b71fb98c7fb973d78af11399deccef19beb008ad9 AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash build-essential ca-certificates curl dhcpcd-base file git \
        e2fsprogs initramfs-tools iproute2 jq linux-image-virtual nodejs npm openssh-client procps \
        python3 python3-pip sudo tini util-linux \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

FROM base AS runtime

ARG CODE_SERVER_VERSION=4.104.2
ARG CODE_SERVER_SHA256=618cb27960e5500a21cc1cd7c9d7b396222c6fe5242e01340312da18cea9945c
ARG TARGETARCH

RUN test "${TARGETARCH}" = "arm64" \
    && curl --fail --location --silent --show-error \
        "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_arm64.deb" \
        --output /tmp/code-server.deb \
    && echo "${CODE_SERVER_SHA256}  /tmp/code-server.deb" | sha256sum --check --strict \
    && dpkg -i /tmp/code-server.deb \
    && rm -f /tmp/code-server.deb

COPY ezil-init /sbin/ezil-init
RUN chmod 0755 /sbin/ezil-init \
    && mkdir -p /workspace /home/ezil/.local/share/code-server /home/ezil/.config/code-server \
    && useradd --create-home --uid 10001 --shell /bin/bash ezil \
    && chown -R ezil:ezil /home/ezil

LABEL org.opencontainers.image.title="EZiL OS local ARM runtime" \
      org.opencontainers.image.source="https://github.com/EZiLHQ/ezil-os" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
