# Codex container

Run Codex in a disposable Linux VM using Apple's `container` runtime. The image
contains Wolfi Linux, Node, pnpm, mise, Codex CLI, agent-browser, Git, Git LFS,
Jujutsu, and Herdr's `hc`. The default image has no browser engine, npm, npx,
compiler, development headers, or make. Scripts are TypeScript executed directly by Node;
there is no compilation step or Python tooling requirement.

## Setup

Use an Apple silicon Mac supported by Apple's container runtime. Install mise and
host `hc` first. The required `hc` version is recorded as `IMAGE_HC_VERSION` in
`mise.toml`; use that version on the host too. The image installer downloads its
Linux build and verifies the release manifest's SHA-256 checksum.

```sh
mise trust
mise install
mise run setup
container system start
mise run build
mise run check
mise run check:image
mise run scan
mise run smoke
```

`mise.toml` pins host tooling and image tool versions. The Apple runtime is a
macOS-only mise dependency. Distribution packages are listed in `Dockerfile` and
upgraded during uncached builds. Wolfi's base is digest-pinned in `mise.toml`;
update that pin when refreshing the base. `pnpm-lock.yaml` locks the development
type definitions and their dependencies. Mise bootstraps pnpm using its embedded
package installer, then uses pnpm for the other JavaScript tools. The `npm:` mise
backend name denotes the package registry; it does not require npm in the image.

If guest DNS cannot resolve public names, select a resolver explicitly:

```sh
mise run build --dns 1.1.1.1
CONTAINER_DNS=1.1.1.1 mise run smoke
```

This changes DNS for those guests, without changing the Mac's DNS settings.

## Run Codex

From this repository, select an existing checkout or linked worktree:

```sh
mise run codex --checkout /path/to/worktree
```

This creates a guest, registers it temporarily with host `hc`, starts Codex in a
guest-core terminal, and attaches your terminal. Codex uses `--no-daemon` and
`--dangerously-bypass-approvals-and-sandbox`. The VM provides the filesystem
boundary. When the attachment ends, including detaching with Ctrl+backslash,
the launcher unregisters and destroys the guest. Files in mounted directories
remain on the host.

Put guest options first, then Codex arguments:

```sh
mise run codex --checkout /path/to/worktree --model gpt-6.1
```

The default guest has four CPUs and 4 GB of memory. Override these with `--cpus`
and `--memory`. `--dns` and `--image` are also available. `--home` selects a home
containing `.codex` and `.agents/skills`; it never mounts the whole home.

## Keep a guest running

For work that must survive detaching, start a guest explicitly:

```sh
mise run start --checkout /path/to/worktree --name cs-feature
mise run shell cs-feature
mise run status
```

Inside that shell, launch a guest-core terminal:

```sh
hc run --bg --name codex -- codex --no-daemon \
  --dangerously-bypass-approvals-and-sandbox \
  -c 'cli_auth_credentials_store="file"'
```

On the host:

```sh
mise run attach cs-feature
hc ls
hc read cs-feature/codex
mise run stop cs-feature
```

The guest stays alive until `stop`. A forced launcher kill or Mac shutdown can
also leave a guest or registration behind; use `status` and `stop` to clean it up.
The launcher only deletes guests carrying its ownership label and `cs-` name.

## What is shared

| Host path                                                                     | Guest access                                           | Purpose                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| Selected checkout/worktree                                                    | Read/write, same absolute path                         | Immediate file sharing                                           |
| Common Git directory for linked worktrees                                     | Read/write, same path                                  | Objects, refs, index pointers, commits                           |
| Shared JJ repository and backing Git metadata                                 | Read/write, same path                                  | Existing JJ workspaces                                           |
| Normal `~/.codex`                                                             | Read/write, same path                                  | Login, configuration, skills, plugins, history                   |
| `~/.agents/skills`                                                            | Read-only, same path                                   | User skills                                                      |
| Skill/plugin symlink targets and linked Codex config/login/instructions files | Read/write for Codex state; read-only for agent skills | Preserve symlink resolution without exposing the target's parent |

Mounts are printed before guest startup. Sibling checkout contents are not
mounted. Shared Git/JJ metadata can still change refs used by other worktrees.
The guest can modify or delete the selected checkout and your entire mounted
Codex directory; this is the intended sharing boundary. Skills located within
`.codex` are writable. A symlink that would mount the whole host home is rejected.

Host `~/.ssh`, `~/.aws`, global Git configuration, SSH agents, Docker/Apple control
sockets, and host `hc` configuration/socket are not mounted. Configure a Git
identity inside the guest if it needs to create commits. Host signing and
credential helpers are not automatically usable on Linux. No credentials or
checkout contents enter the build context or image.

### Login and host-specific configuration

Codex is launched with `cli_auth_credentials_store="file"`, so an existing
`.codex/auth.json` is available and refreshes persist. A login stored only in
macOS Keychain does not follow the mount. In that case, log in from a guest with
file storage selected; do not copy credentials into the repository or image.

Your normal Codex configuration is also loaded. Skills that invoke macOS tools,
host-only MCP servers, or unavailable absolute executable paths need Linux
equivalents. Sharing state does not make those programs available. Concurrent
host and guest logins also share the writable auth cache; avoid simultaneous
login/logout or independent refresh attempts if the subscription provider
rejects reused refresh tokens.

This initial version requires `.codex` itself to be a real directory and skill
symlinks to point directly to canonical targets. It rejects chained links with
a clear error. Linked `config.toml` and `auth.json` must point inside the selected
checkout or Codex directory, where atomic file replacement can persist. External
file-only mounts cannot provide that persistence. Your existing regular Codex
directory does not require a separate login or copied configuration.

### Herdr connection

Each guest has an independent `hc` core. The host registers it using
`hc machine add --temp --via`, with `container exec -i GUEST sh -c` as the
byte-preserving transport. No SSH server, SSH login, or forwarded host `hc`
socket is needed. Host `hc` can supervise the guest's terminals; guest `hc`
manages guest processes and starts with no host machine connections.

### Repository mise configurations

Repository configs are available through the checkout mount. In a guest shell,
review and trust the repo config, then run `mise install` and the repo's tasks.
Tool downloads and caches live on the guest disk and disappear on teardown.
The image contains the common runtime tools; it does not automatically
trust every mounted config or bake arbitrary repository setup hooks into it.

Install repository-specific build tools inside the guest. For example,
`apk add --no-cache build-base` installs Wolfi's compiler and make; install
additional headers as the repository needs them. Mise can install language
toolchains, while distribution packages supply their required system libraries.
These changes disappear with the guest. For repeated use, add a derived image
instead of expanding the shared default image.

Mise also supports system packages through `[bootstrap.packages]`. Its `apk`
manager works in this image. This keeps repository-specific system dependencies
in `mise.toml`, alongside tool versions. See the tested example in
[the base image decision](docs/base-image.md#mise-support).

## Optional browser

Codex and `hc` do not need Chromium. Agent-browser is the automation CLI; it
needs a browser engine for browser commands. It remains in the default image
without the browser engine.

Build and test a separate image with current Chrome for Testing:

```sh
mise run build:browser
mise run check:browser
mise run scan:browser
mise run smoke:browser
mise run codex --image codex-sandbox:browser --checkout /path/to/worktree
```

Or install the pinned browser and its runtime libraries in a running guest:

```sh
mise run browser cs-feature
```

The installer verifies the architecture-specific download checksum and requires
the pinned version to match Google's current stable release. Update the version
and both checksums in `mise.toml` when that gate fails. The installed browser is
discoverable as `google-chrome`; its provenance is recorded in
`/opt/chrome/vendor-release.json`. A guest installation disappears on teardown.
No host browser or browser profile is mounted.

## Wolfi and Debian slim

Wolfi is the default because the trimmed image passes the current security gate
and supports the required Linux tools. The equivalent Debian slim image retains
128 HIGH/CRITICAL findings and an older OpenSSH release. Wolfi uses glibc, which
supports common prebuilt Linux tools. Mise language installs, config-defined
environment variables, tasks, and APK bootstrap passed live checks in this image.

The current APK catalogue contains about 16,000 distinct package names. It covers
common development tools and libraries, but it is not a Debian replacement for
every repo. Package names, `apt` assumptions, BusyBox utilities, and source-build
dependencies need review. Wolfi and Alpine packages cannot be mixed.

[The base image decision](docs/base-image.md) records the evidence, package
coverage, mise example, tradeoffs, and reasons to select Debian instead.

The Dockerfile also supports a trimmed Debian 13 slim comparison:

```sh
mise run build:debian
mise run scan:debian
```

Debian slim remains useful for repos tied to Debian packages. The initial image
already used a slim base; removing the bundled browser and build tools accounts
for much of the reduction. The current Debian comparison still fails the
security gate and minimum OpenSSH check, so Wolfi is the default. See
[verification](docs/verification.md) for measured results and compatibility checks.

## Checks and CI

```sh
mise tasks
mise run fmt
mise run check
mise run audit
mise run build
mise run check:image
mise run scan
mise run smoke
```

`check` runs Biome, TypeScript checking, Prettier, Markdownlint, Taplo, Hadolint,
Actionlint, and Node's unit tests. `smoke` uses fake Codex state and a disposable
linked worktree. It checks tool availability, skill symlinks, Git writes visible
on the host, a host file outside the mounts being absent, host `hc` reading a
guest terminal, and registration/VM teardown. It does not send a model request.

GitHub Actions runs lint/tests and builds both amd64 and arm64 Linux images with
Docker, for both core and browser variants. Each image runs the core tool check
and Trivy scan; browser variants also exercise agent-browser against Chrome.
`build:ci`, `check:image:ci`, and `scan:ci` are the named Docker equivalents.
The Apple VM and host `hc` integration test runs locally on macOS, separately
from the Linux CI checks. CI also runs weekly to pick up new advisories.

Trivy scans OS and discoverable language dependencies and writes the complete
report, including unfixed and lower-severity vulnerabilities, to
`.artifacts/vulnerabilities-<image-tag>.json`. The check fails on HIGH or CRITICAL findings;
there is no blanket ignore-unfixed policy or suppression file. CI preserves
the report even when the check fails. A clean report is limited to the scanner's
supported package/binary inventories and current advisory database. Downloaded
Chrome is not a distribution package: the vendor version/checksum/freshness
checks complement the scan, and a clean scan does not establish complete Chrome
CVE coverage.

## Sources

- [Apple container](https://github.com/apple/container)
- [Codex CLI](https://learn.chatgpt.com/docs/cli)
- [Agent-browser installation](https://agent-browser.dev/installation)
- [Mise containers](https://mise.jdx.dev/mise-cookbook/docker.html)
- [Herdr core](https://herdr.dev/core/)
