#!/usr/bin/env bash
set -euo pipefail

case "$RUNNER_ARCH" in
  ARM64)
    arch=arm64
    checksum=52f4a75495bde5571d5d0a45b4d9b5227c2c099b92f9be85328569e67b12c553
    ;;
  X64)
    arch=x64
    checksum=9c12c24f5eac6b6357e5265e2629166cc3005459037f5d747680a99e375ff2ab
    ;;
  *)
    echo "Unsupported Linux runner architecture: $RUNNER_ARCH" >&2
    exit 1
    ;;
esac
tool_dir="$(mktemp -d "$RUNNER_TEMP/agent-sandbox-mise.XXXXXX")"
mkdir -p "$tool_dir/bin"
binary="$tool_dir/bin/mise"
curl -fsSL "https://github.com/jdx/mise/releases/download/v2026.11.12/mise-v2026.11.12-linux-$arch" -o "$binary"
printf '%s  %s\n' "$checksum" "$binary" | sha256sum -c -
chmod 755 "$binary"

export MISE_DATA_DIR="$tool_dir/data"
printf 'MISE_DATA_DIR=%s\n' "$MISE_DATA_DIR" >>"$GITHUB_ENV"
printf '%s\n' "$tool_dir/bin" >>"$GITHUB_PATH"
"$binary" trust "$GITHUB_WORKSPACE/mise.toml"
"$binary" install --locked
