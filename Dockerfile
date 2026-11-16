# syntax=docker/dockerfile:1
ARG MISE_VERSION
ARG NODE_VERSION
ARG DISTRO=wolfi
ARG WOLFI_BASE
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise
FROM node:${NODE_VERSION}-trixie-slim AS node

FROM debian:trixie-slim AS debian
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git git-lfs jq less libatomic1 libstdc++6 \
        openssh-client procps ripgrep tini unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
# Copy only the runtime, excluding npm, npx, Yarn, and their dependency trees.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

FROM ${WOLFI_BASE} AS wolfi
ARG NODE_VERSION
# hadolint ignore=DL3018
RUN apk upgrade --no-cache && apk add --no-cache \
    bash ca-certificates-bundle curl git git-lfs jq less \
    "nodejs-24~${NODE_VERSION}" openssh-client procps ripgrep tini unzip xz

FROM ${DISTRO} AS base
ARG CODEX_VERSION
ARG PNPM_VERSION
ARG AGENT_BROWSER_VERSION
ARG HC_VERSION
ARG JJ_VERSION
ARG BROWSER_VERSION
ARG BROWSER_SHA256_ARM64
ARG BROWSER_SHA256_AMD64
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV SHELL="/bin/bash" LANG="C.UTF-8" \
    PNPM_HOME="/opt/pnpm-home" MISE_NPM_PACKAGE_MANAGER="pnpm" \
    PATH="/opt/pnpm-home:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    BROWSER_VERSION="${BROWSER_VERSION}" \
    BROWSER_SHA256_ARM64="${BROWSER_SHA256_ARM64}" \
    BROWSER_SHA256_AMD64="${BROWSER_SHA256_AMD64}" \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"
COPY image/install.ts image/check.ts image/browser.ts /opt/codex-container/
RUN node /opt/codex-container/install.ts
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

FROM base AS browser
RUN node /opt/codex-container/browser.ts
ENV AGENT_BROWSER_EXECUTABLE_PATH="/opt/chrome/chrome"
