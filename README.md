# Agent sandbox

Run Codex, Claude Code, OpenCode or a shell in a persistent Linux sandbox on your
Apple silicon Mac. Give an agent room to install tools, change code and run tests
while choosing which host files it can access.

No host checkout, credentials or skills are mounted by default. You can share a
Git worktree, reuse a file-backed Codex login without another sign-in, and open
the agent in its own Herdr space. Each sandbox keeps its tools and session state
until you delete it.

Version **0.1.0**. See the [changelog](CHANGELOG.md).

## Install

You need an Apple silicon Mac supported by Apple's `container` runtime, Git and
[mise](https://mise.jdx.dev). Herdr is optional.

```sh
git clone https://github.com/jeremyhiggs/agent-sandbox.git agent-sandbox
cd agent-sandbox
mise trust
mise install --locked
mise run setup
container system start
mise run build
mise run check
mise run check:image
mise run scan
mise run install
```

Keep `~/.local/bin` on your `PATH`. Installation copies the runtime to
`~/.local/share/agent-sandbox`; the source checkout can then move or be removed.
Re-run `mise run install` after updating the source. Image builds use pinned
versions, checksums and frozen dependency graphs; launching a sandbox does not
refresh them. See [installation details](docs/usage.md#installation) and
[reproducibility](docs/reproducibility.md).

## Run an agent

From the checkout or linked worktree you want to share:

```sh
cd /path/to/worktree
agent-sandbox run --name codex-work --agent codex \
  --mount-git --mount-codex-auth
```

This opens Codex at the checkout root and reuses an existing file-backed host
login. See [authentication limitations](#authentication-limitations) before
sharing credentials. To start with no host files or credentials, omit the mount
flags:

```sh
agent-sandbox run --name scratch --agent codex
```

Use `--agent claude` or `--agent opencode` for the other agent images, or omit
`--agent` for Bash. Claude and OpenCode require login inside the sandbox.
All four images include mise, Node, pnpm, Git, Git LFS, GitHub CLI, hc,
agent-browser, Chrome, Podman and Podman Compose. New sandboxes can
[run rootless containers inside the guest](docs/usage.md#nested-containers).
Install project-specific dependencies inside the guest. See
[images and tools](docs/usage.md#images).

The default allocation is **4 CPUs and 4 GB RAM**. Set `--cpus` and `--memory`
when creating a sandbox; mounts and resources cannot be changed afterward.
Without `--mount-git`, commands start in `/workspace`. Other mounts do not select
the working directory.

With `--mount-git`, the host resolves that checkout's commit names and emails
automatically. Set `--git-name` and `--git-email` at creation to override them;
see [Git commit identity](docs/usage.md#git-commit-identity).

## Choose what to share

| Option                          | Host access                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--mount-git [PATH]`            | Read/write checkout or linked worktree, including required Git metadata; defaults to the current checkout |
| `--mount-codex-auth`            | Read-only host `~/.codex/auth.json`; other Codex state stays guest-local                                  |
| `--mount-skills`                | Read-only `~/.agents/skills` and its approved direct symlink targets                                      |
| `--volume SOURCE:TARGET:ro\|rw` | An existing host directory at an absolute guest path; repeat for multiple directories                     |

`--volume` (or `-v`) follows [Apple's `--volume`](https://github.com/apple/container/blob/1.7.1/docs/volumes.md#share-host-data)
and [Docker's `-v` syntax](https://docs.docker.com/engine/storage/bind-mounts/#syntax).
Use an existing directory and an explicit `ro` or `rw` mode.

For example, add read-only reference material and a writable output directory:

```sh
agent-sandbox run --name analysis --agent codex --mount-codex-auth \
  --volume "$HOME/Documents/reference:/reference:ro" \
  --volume "$HOME/Documents/sandbox-output:/output:rw"
```

Mounts are printed before startup. An agent can modify or delete writable shared
files, including Git history and refs. Host SSH keys, GitHub credentials, signing
agents and global Git configuration are not forwarded automatically. The guest
has network access; it can publish if you give it credentials. There is no
enforced push-approval gate.

Managed Codex bypasses its own approvals and sandbox inside the container. Host
permission checks remain enabled; Claude retains its normal permission prompts.
See [file-sharing boundaries](docs/sharing.md#available-mounts) for restrictions.

## Open a Herdr session

With host hc installed at the version in `IMAGE_HC_VERSION` in `mise.toml`, add
`--herdr` when creating a sandbox:

```sh
agent-sandbox run --name worker --agent codex --detach \
  --mount-git --mount-codex-auth --herdr \
  --prompt 'Inspect this checkout, confirm your hc parent, and report readiness to it using hc send before starting work'
agent-sandbox terminals --name worker
hc send worker/TERMINAL_ID 'Run the focused tests and report the results'
```

Replace `TERMINAL_ID` with an ID from `terminals`. `--herdr` creates a dedicated
space without changing your selected space. `--detach` returns while the agent
keeps running. Launch directly from the supervising host hc terminal if you want
the guest agent to report to it through hc's native parent connection.
See [Herdr supervision and worker handoff](docs/herdr.md).

`--detach` prints the new terminal ID on stdout and an attach hint on stderr.
`agent-sandbox terminals --name worker` returns JSON with terminal IDs and names
by default. Add `--json` for a consistent result envelope across CLI commands:

```sh
agent-sandbox run --name json-worker --agent codex --detach --json
agent-sandbox status --json
```

JSON reserves stdout for command metadata and sends progress and workload output
to stderr. Managed launches require explicit `--detach`; interactive `attach`
returns a structured error in JSON mode. See [structured output](docs/usage.md#structured-output).

## Reconnect, stop or delete

Replace `TERMINAL_ID` with an ID returned by `terminals`:

```sh
agent-sandbox shell --name codex-work
agent-sandbox terminals --name codex-work
agent-sandbox attach --name codex-work --terminal TERMINAL_ID
agent-sandbox shell --name codex-work --exec pnpm test
agent-sandbox status
agent-sandbox stop --name codex-work
agent-sandbox start --name codex-work --agent codex
```

Exiting or detaching a terminal leaves the sandbox running. `stop` ends its
processes but keeps the filesystem; `start` opens a new shell or agent.

`agent-sandbox delete --name codex-work` destroys guest-local files, logins and
session history. Shared host files remain. A sandbox created with `--rm` is also
deleted on **stop**, so export guest-local work before stopping it.
See [lifecycle details](docs/usage.md#stop-restart-and-delete).

## Authentication limitations

`--mount-codex-auth` requires a regular, file-backed host `auth.json`. A
keychain-only login is not transferred. The mount is read-only: if credential
refresh fails, renew the host login and stop/start a persistent sandbox to
reattach the current file. With `--rm`, export work before stopping, then recreate
the sandbox. See [Codex auth setup and recovery](docs/sharing.md#codex-read-only-authentication).

The container process sees only the mounted auth file, but Apple Container 1.7.1
shares its parent directory with the VM internally. This is not an auth-only
export at the VM boundary. Host and guest also share the provider login grant;
guest refresh or logout can affect the host login.

Claude Code and OpenCode do not have host-auth mount presets. Sign in inside the
guest; their authenticated workflows have not been verified. See
[authentication and guest state](docs/sharing.md).

## More documentation

- [Usage and installation details](docs/usage.md): terminals, images, resources and repository tools.
- [File sharing and authentication](docs/sharing.md): mount rules, login recovery, skills and guest-local databases.
- [Herdr supervision](docs/herdr.md): host/guest messaging, session routing and durable handoff.
- [Verification](docs/verification.md): local checks, opt-in live tests, CI and coverage limits.
- [Reproducibility](docs/reproducibility.md): version pins, hashes, lock refresh and vulnerability exceptions.
- [Base image](docs/base-image.md): Wolfi packages and compatibility limits.

Run `agent-sandbox --help` for command options or `agent-sandbox --skill` for
bundled agent guidance. For development, start with `mise run check` and
`mise run audit`; follow [AGENTS.md](AGENTS.md) before committing or publishing.
