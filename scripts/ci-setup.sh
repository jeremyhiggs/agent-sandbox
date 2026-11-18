#!/usr/bin/env bash
set -euo pipefail

# Verify the standalone executable before running any downloaded code.
case "$RUNNER_ARCH" in
  ARM64)
    arch=arm64
    checksum=e4392a51b1b99107b3dd0c8c1b1efa737b614e15950af34921067ce829929af8
    ;;
  X64)
    arch=x64
    checksum=8f5426d9971eaf713b37509749174ca69cf2f08b8b25e389168dcfcab9cd1a4d
    ;;
  *) echo "Unsupported Linux runner architecture: $RUNNER_ARCH" >&2; exit 1 ;;
esac
tool_dir="$(mktemp -d "$RUNNER_TEMP/agent-sandbox-mise.XXXXXX")"
mkdir -p "$tool_dir/bin"
binary="$tool_dir/bin/mise"
curl -fsSL "https://github.com/jdx/mise/releases/download/v2026.11.7/mise-v2026.11.7-linux-$arch" -o "$binary"
printf '%s  %s\n' "$checksum" "$binary" | sha256sum -c -
chmod 755 "$binary"

# Fresh tools and no restored cache: every first install uses the committed locks.
export MISE_DATA_DIR="$tool_dir/data"
printf 'MISE_DATA_DIR=%s\n' "$MISE_DATA_DIR" >> "$GITHUB_ENV"
printf '%s\n' "$tool_dir/bin" >> "$GITHUB_PATH"
"$binary" trust "$GITHUB_WORKSPACE/mise.toml"
"$binary" install --locked
