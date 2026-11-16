# syntax=docker/dockerfile:1
ARG WOLFI_BASE
ARG MISE_BASE
FROM ${MISE_BASE} AS mise

FROM ${WOLFI_BASE} AS base
ARG TARGETARCH
COPY image/locks/wolfi/${TARGETARCH}/base.txt /tmp/packages.lock
RUN xargs apk add --no-cache < /tmp/packages.lock && rm /tmp/packages.lock

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
COPY image/*.ts image/artifacts.json /opt/codex-container/
COPY image/locks/ /opt/codex-container/locks/
COPY image/tools/package.json image/tools/pnpm-lock.yaml /opt/agent-tools/
RUN node /opt/codex-container/install.ts
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

FROM base AS browser
RUN node /opt/codex-container/browser.ts
ENV AGENT_BROWSER_EXECUTABLE_PATH="/opt/chrome/chrome" IMAGE_PROFILE="browser"
