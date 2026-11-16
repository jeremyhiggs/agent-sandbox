# Codex container

Run Codex in a disposable Linux VM using Apple's `container` runtime. The image
contains Wolfi Linux, Node, pnpm, mise, Codex CLI, agent-browser, Git, Git LFS,
Jujutsu, and Herdr's `hc`. The default image has no browser engine, npm, npx,
compiler, development headers, or make. Scripts are TypeScript executed directly by Node;
there is no compilation step or Python tooling requirement.

## Setup

Use an Apple silicon Mac supported by Apple's container runtime. Install mise and
host `hc` first. The required `hc` version is recorded as `IMAGE_HC_VERSION` in
`mise.toml`; use that version on the host too. The image installer verifies its
Linux archive against the SHA-256 checksum in `image/artifacts.json`.

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
macOS-only mise dependency. All base images have digest pins. Complete OS package
locks live under `image/locks/wolfi/`, for both profiles and architectures.
Normal builds install exact versions and check the installed inventory. CLI
archives have checksum pins, and image tools use a frozen pnpm lockfile. See
[reproducible dependencies](docs/reproducibility.md) for the lock files and refresh tasks.

Apple builds and guests use `1.1.1.1` as their default DNS resolver. To select
another resolver:

```sh
mise run build --dns 8.8.8.8
CONTAINER_DNS=8.8.8.8 mise run smoke
```

This changes DNS for those guests, without changing the Mac's DNS settings.

## Install the launcher command

From this repository:

```sh
mise run install
```

From another directory, use `mise -C /path/to/codex-container run install`.

This installs `codex-container` in `~/.local/bin`. Keep that directory on `PATH`.
The command loads this repository's pinned mise environment, then runs from your
original directory. Keep this repository at its installed location; the command
references it. `--bin-dir PATH` selects a different installation directory.
Installation is repeatable and refuses to overwrite a different existing command.

From any existing checkout or linked worktree:

```sh
codex-container
```

It selects the current checkout by default. You can also use
`codex-container --checkout /path/to/worktree`, or the `build`, `scan`,
`start`, `stop`, `shell`, `attach`, `browser`, and `status` subcommands. Repo-local
mise tasks remain available. Run `mise run smoke:cli` to test the installed
command's worktree selection, mount boundaries, hc registration, and cleanup.
Smoke tests use a separate `hc` session with scratch configuration/state and
remove it afterward; they do not register guests in your normal Herdr core.

## Run Codex

From an existing checkout or linked worktree, run:

```sh
codex-container
```

You can run this command in any terminal, including a Herdr tab. It selects the
current checkout and creates a disposable guest. It registers the guest with host
`hc`, starts Codex, and attaches your terminal. Codex uses `--no-daemon` and
`--dangerously-bypass-approvals-and-sandbox` inside the VM.

To select another checkout or worktree, run:

```sh
codex-container --checkout /path/to/worktree
```

Put guest options before `--`. Put a Codex task or Codex arguments after `--`:

```sh
codex-container -- "Run the tests and fix failures"
codex-container --cpus 6 --memory 8G -- "Review the current changes"
```

The default guest has four CPUs and 4 GB of memory. `--dns` and `--image` select
the resolver and image. `--home` selects a home containing `.codex` and
`.agents/skills`; it does not mount the whole home.

Exit Codex to stop and destroy the guest. Detaching with Ctrl+backslash also
destroys it. Your checkout changes and mounted Codex state remain on the host.
Run `codex-container --help` for the launcher options. Repo-local tasks such as
`mise run codex --checkout /path/to/worktree` remain available.

## Keep a guest running

For work that must survive detaching, start a guest explicitly:

```sh
codex-container start --name cs-feature
codex-container shell cs-feature
codex-container status
```

Inside that shell, launch a guest-core terminal:

```sh
hc run --bg --name codex -- codex --no-daemon \
  --dangerously-bypass-approvals-and-sandbox \
  -c 'cli_auth_credentials_store="file"'
```

On the host:

```sh
codex-container attach cs-feature
hc ls
hc read cs-feature/codex
codex-container stop cs-feature
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
`hc machine add --via`, with `container exec -i GUEST sh -c` as the
byte-preserving transport. No SSH server, SSH login, or forwarded host `hc`
socket is needed. Host `hc` can supervise the guest's terminals; guest `hc`
manages guest processes and starts with no host machine connections.

The registration is visible in Herdr's app. It deliberately omits `--temp`,
because Herdr hides machines with that flag. `stop` still removes the host
registration and destroys the guest. To open a running guest in the app:

```sh
herdr-app do space.new --name "Container worktree" \
  --machine cs-feature --folder /path/to/worktree
```

Close that Herdr space before stopping the guest. The app launches its terminal
through the guest's own core; it does not need the host socket mounted inside.

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

The installer verifies the architecture-specific download checksum and uses the
pinned version. The separate `audit:browser` check compares that pin with Google's
current stable release. This keeps old pinned builds reproducible while making
outdated browser pins fail the security audit. The installed browser is
discoverable as `google-chrome`; its provenance is recorded in
`/opt/chrome/vendor-release.json`. A guest installation disappears on teardown.
No host browser or browser profile is mounted.

## Wolfi base image

Wolfi is the only supported base because the trimmed image passes the current security gate
and supports the required Linux tools. The earlier Debian slim comparison recorded
128 HIGH/CRITICAL findings and an older OpenSSH release. Wolfi uses glibc, which
supports common prebuilt Linux tools. Mise language installs, config-defined
environment variables, tasks, and APK bootstrap passed live checks in this image.

The current APK catalogue contains about 16,000 distinct package names. It covers
common development tools and libraries, but it is not a Debian replacement for
every repo. Package names, `apt` assumptions, BusyBox utilities, and source-build
dependencies need review. Wolfi and Alpine packages cannot be mixed.

[The base image decision](docs/base-image.md) records the evidence, package
coverage, mise example, and compatibility limits. The earlier Debian comparison
is retained in [verification](docs/verification.md) as historical evidence;
its build targets, tasks, and package locks have been removed.

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
Actionlint, lock validation, and Node's unit tests. `smoke` uses fake Codex state and a disposable
linked worktree. It checks tool availability, skill symlinks, Git writes visible
on the host, a host file outside the mounts being absent, host `hc` reading a
guest terminal, and registration/VM teardown. It does not send a model request.

GitHub Actions runs lint/tests and builds both amd64 and arm64 Linux images with
Docker, for both core and browser variants. Each image runs the core tool check
and Trivy scan; browser variants also exercise agent-browser against Chrome.
`build:ci`, `check:image:ci`, and `scan:ci` are the named Docker equivalents.
The Apple VM and host `hc` integration test runs locally on macOS, separately
from the Linux CI checks. CI runs on pushes, pull requests, manual requests,
and every day at **00:00 UTC** to pick up new advisories.

`mise run audit` runs four independent checks: pnpm audits of the repository and
image-tool lockfiles, a Trivy repository scan including development dependencies,
and browser freshness. The image matrix also scans each built image with Trivy.
There are no automated dependency update PRs.

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
