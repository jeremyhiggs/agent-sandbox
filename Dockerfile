# syntax=docker/dockerfile:1
ARG MISE_VERSION
ARG NODE_VERSION
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise

FROM node:${NODE_VERSION}-trixie-slim
ARG CODEX_VERSION
ARG NPM_VERSION
ARG AGENT_BROWSER_VERSION
ARG HC_VERSION
ARG JJ_VERSION
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# Rebuild with --pull to consume Debian security updates.
# hadolint ignore=DL3008,DL3009,DL3015
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        bash build-essential ca-certificates chromium curl git git-lfs jq less \
        libssl-dev openssh-client pkg-config procps \
        ripgrep tini unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV AGENT_BROWSER_EXECUTABLE_PATH="/usr/bin/chromium" \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" \
    SHELL="/bin/bash" \
    LANG="C.UTF-8"
COPY image/install.ts /opt/codex-container/install.ts
COPY image/check.ts /opt/codex-container/check.ts
RUN node /opt/codex-container/install.ts
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
