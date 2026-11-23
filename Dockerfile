ARG MISE_BASE
FROM ${MISE_BASE} AS mise

FROM scratch AS base
ARG OS_ARCHIVE
# hadolint ignore=DL3020
ADD ${OS_ARCHIVE} /

ARG PNPM_VERSION
ARG AGENT_BROWSER_VERSION
ARG HC_VERSION
ARG BROWSER_VERSION
ARG BROWSER_SHA256_ARM64
ARG BROWSER_SHA256_AMD64
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV SHELL="/bin/bash" LANG="C.UTF-8" SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt" \
    PNPM_HOME="/opt/pnpm-home" \
    PATH="/opt/pnpm-home:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    BROWSER_VERSION="${BROWSER_VERSION}" \
    BROWSER_SHA256_ARM64="${BROWSER_SHA256_ARM64}" \
    BROWSER_SHA256_AMD64="${BROWSER_SHA256_AMD64}" \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" \
    AGENT_BROWSER_EXECUTABLE_PATH="/opt/chrome/chrome"
COPY image/install.ts image/browser.ts image/packages.ts image/artifacts.json /opt/agent-sandbox/
COPY image/apko.lock.json /opt/agent-sandbox/apko.lock.json
COPY image/tools/base/package.json image/tools/base/pnpm-lock.yaml pnpm-workspace.yaml /opt/tools/base/
RUN node /opt/agent-sandbox/install.ts && node /opt/agent-sandbox/browser.ts
COPY image/check.ts /opt/agent-sandbox/
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

FROM base AS agent
COPY image/agent.ts /opt/agent-sandbox/

FROM agent AS codex
ARG CODEX_VERSION
COPY image/tools/codex/package.json image/tools/codex/pnpm-lock.yaml pnpm-workspace.yaml /opt/tools/codex/
RUN node /opt/agent-sandbox/agent.ts codex "${CODEX_VERSION}"
ENV IMAGE_AGENT="codex"

FROM agent AS opencode
ARG OPENCODE_VERSION
COPY image/tools/opencode/package.json image/tools/opencode/pnpm-lock.yaml pnpm-workspace.yaml /opt/tools/opencode/
RUN node /opt/agent-sandbox/agent.ts opencode "${OPENCODE_VERSION}"
ENV IMAGE_AGENT="opencode"

FROM agent AS claude
ARG CLAUDE_VERSION
COPY image/tools/claude/package.json image/tools/claude/pnpm-lock.yaml pnpm-workspace.yaml /opt/tools/claude/
RUN node /opt/agent-sandbox/agent.ts claude "${CLAUDE_VERSION}"
ENV IMAGE_AGENT="claude"
