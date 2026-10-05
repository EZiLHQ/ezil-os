# Build against the final Ubuntu22 runtime ABI; never ship a newer glibc.
FROM golang:1.25-bookworm AS toolchain
FROM ubuntu:22.04 AS server
ENV PATH="/usr/local/go/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=toolchain /usr/local/go /usr/local/go
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config ca-certificates git libx11-dev libxrandr-dev libxtst-dev libgtk-3-dev libxcvt-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/m1k1o/neko.git . && git checkout d74052bb844c43a0cc3c2386d083f7505dc483a2
COPY continuity.patch /tmp/continuity.patch
RUN git apply /tmp/continuity.patch
COPY relay.go relay_test.go server/internal/webrtc/
WORKDIR /src/server
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build gofmt -w internal/webrtc/relay.go && go test ./internal/webrtc ./pkg/auth ./internal/http/legacy/... && ./build core

FROM node:18-bookworm-slim AS client
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/m1k1o/neko.git . && git checkout d74052bb844c43a0cc3c2386d083f7505dc483a2
COPY continuity.patch /tmp/continuity.patch
RUN git apply /tmp/continuity.patch
WORKDIR /src/client
RUN --mount=type=cache,target=/root/.npm npm ci && npm run build

FROM scratch AS artifacts
COPY --from=server /src/server/bin/neko /neko
COPY --from=client /src/client/dist /www
