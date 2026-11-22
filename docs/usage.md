# Usage and installation details

Use this guide for command behavior and output. For the first build and launch,
see the [README](../README.md). For file access and host supervision, see
[sharing](sharing.md) and [Herdr](herdr.md).

- [Installation](#installation)
- [Create and use a sandbox](#create-and-use-a-sandbox)
- [Structured output](#structured-output)
- [Stop, restart, and delete](#stop-restart-and-delete)
- [Images](#images)
- [Repository mise configuration](#repository-mise-configuration)

## Installation

`mise run install` copies the runtime, image recipes, locks and bundled guidance
to `~/.local/share/agent-sandbox`, and installs `~/.local/bin/agent-sandbox`.
Keep that bin directory on `PATH`. The source checkout can move or be removed;
re-run installation after updating the source.

The launcher uses its copied mise pins and restores the caller's working
directory. Node and Apple's CLI remain managed by mise; installation does not
copy their executables. It trusts the copied `mise.toml` and refuses to replace
an unrelated command or runtime directory. Keep project files elsewhere.

From another directory, or with custom destinations:

```sh
mise -C /path/to/agent-sandbox run install
mise run install -- --bin-dir /path/to/bin --install-dir /path/to/runtime
agent-sandbox --version
agent-sandbox --help
agent-sandbox --skill
```

`--skill` prints bundled workflow guidance without a separate skill installation.
The CLI version and the image's tool versions are independent.

## Create and use a sandbox

```sh
agent-sandbox run --name feature --agent codex --mount-git --mount-codex-auth
agent-sandbox shell --name feature --agent codex --terminal reviewer
agent-sandbox terminals --name feature
agent-sandbox attach --name feature --terminal reviewer
```

`run` creates a named sandbox. `shell` opens another terminal; `attach` reconnects
to one that already exists. Names use 1–50 lowercase letters, digits, hyphens or
underscores, starting with a letter or digit. Herdr limits names to 32 characters.
A bare CLI invocation prints help.

### Starting directory and settings

| Setting                         | Behavior                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No checkout mount               | Start in guest-local `/workspace`                                                                               |
| `--mount-git [PATH]`            | Share the current or selected checkout and start at its root, using the same absolute path as the host          |
| `--volume SOURCE:TARGET:ro\|rw` | Share a directory without changing the starting directory; mounting at `/workspace` supplies its contents there |
| `--cpus`, `--memory`            | Default to 4 CPUs and 4 GB RAM                                                                                  |
| `--home PATH`                   | Choose the host state/skills source; do not mount the whole home                                                |
| `--dns IP` or `CONTAINER_DNS`   | Override the default `1.1.1.1` resolver for Apple builds and guests                                             |

A path inside a checkout selects its root. Checkout sharing requires host Git
and validated metadata. Mounts, resources, image and Herdr integration are fixed
at creation; `shell` and `start` reuse saved settings.

`--agent` selects the initial image and program at creation. On an existing
sandbox it selects only a program, which must already be installed there.
`--prompt TEXT` supplies its initial prompt and requires `--agent`; it cannot
combine with `--exec`.

### Foreground and detached work

Shells and agents attach in the foreground by default and require a TTY. Detach
with Ctrl+Backslash. Exiting or detaching a terminal leaves the sandbox running.
Use another terminal for concurrent sessions.

`--detach` (`-d`) creates a managed hc terminal, prints its ID on stdout and
returns immediately. An attach hint goes to stderr. For host supervision, launch
directly from the supervising hc terminal with an initial prompt; follow the
[Herdr workflow](herdr.md#connect-a-sandbox).

For an attached session launched by Codex tools, use a PTY (`tty: true`) and a
short `yield_time_ms`, such as 1000. Retain the returned tool session ID to read
output or send input; the foreground launcher remains visible as a background
process in Codex.

### Run a custom command

```sh
agent-sandbox shell --name feature --exec pnpm test
agent-sandbox shell --name feature --exec sh -lc 'mise trust && mise install && mise run test'
```

Put launcher options before `--exec`: every argument after it belongs literally
to the workload. Select a shell explicitly for pipes, expansion or other shell
syntax.

Without `--detach` or `--herdr-space`, custom commands run directly through
`container exec`, preserving stdin, output and exit code with no hc execution
timeout. Either option selects a managed hc terminal instead.

## Structured output

Put `--json` before `--exec` to reserve stdout for one result object. Progress,
build logs and foreground workload output stream to stderr without buffering.
JSON does not imply detached execution.

```sh
agent-sandbox run --name worker --agent codex --detach --json
agent-sandbox terminals --name worker --json
agent-sandbox shell --name worker --json --exec node --test
agent-sandbox status --json
agent-sandbox stop --name worker --json
```

A detached launch returns this shape; IDs vary:

```json
{
  "command": "run",
  "ok": true,
  "exit_code": 0,
  "data": {
    "name": "worker",
    "detached": true,
    "terminal": "t1",
    "address": "worker/t1"
  }
}
```

| Command                 | `data` contents                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `run`, `start`, `shell` | `name`, `detached`, and, for managed terminals, `terminal` and qualified `address` |
| `terminals`             | `name` and hc's terminal-list fields                                               |
| `status`                | `sandboxes` containing `name` and `state`                                          |
| `stop`, `delete`        | `name` after the action completes                                                  |
| `build`                 | `engine`, `profile`, `image`                                                       |
| `scan`                  | `engine`, `image`, retained `report` path                                          |
| `--help`, `--skill`     | Guidance in `text`                                                                 |
| `--version`             | Package `name` and `version`                                                       |

Managed JSON launches require explicit `--detach`, including custom commands
using `--herdr-space`. Direct foreground `--exec` accepts piped input and keeps
the workload's exit code. Interactive `attach --json` returns a structured error
before runtime access; use plain `attach` or `terminals --json` instead.

Launcher errors return `ok: false`, `exit_code: 1` and `error.message`. Completed
foreground workloads return their actual exit code, with `ok: false` for nonzero
exits. Vulnerability-gate failures retain `data.report`.
Scan policy findings return exit 42. Scanner execution errors preserve their
native exit status; see [scan coverage](verification.md#reports-and-scan-coverage).

Use `data.address` with host hc when `--herdr` registration is enabled; otherwise
address guest terminals through `container exec`. See [Herdr supervision](herdr.md).
Without `--json`, detached launches print a bare terminal ID and `terminals`
prints hc's JSON directly, without an envelope.

## Stop, restart, and delete

```sh
agent-sandbox status
agent-sandbox stop --name feature
agent-sandbox start --name feature --agent codex
agent-sandbox delete --name feature
```

| Action                    | Guest processes and files                               |
| ------------------------- | ------------------------------------------------------- |
| Exit or detach a terminal | Other terminals and the sandbox keep running            |
| `stop`                    | End processes and retain the guest filesystem           |
| `start`                   | Open a new shell or agent; do not restore old processes |
| `delete`                  | Destroy guest-local tools, logins and session state     |

Host files in writable shares survive deletion with the changes made to them.
Management commands operate only on sandboxes owned by this launcher.

Add `--rm` at creation to delete the guest filesystem when the sandbox stops,
including on explicit `stop`. Exiting one terminal does not stop it. Before
deletion or stopping an `--rm` guest, export local work and save a
[verified handoff](herdr.md#worker-handoff).

## Images

| Image                    | Agent CLI added                          |
| ------------------------ | ---------------------------------------- |
| `agent-sandbox:base`     | None; the launcher opens Bash by default |
| `agent-sandbox:codex`    | Codex                                    |
| `agent-sandbox:opencode` | OpenCode                                 |
| `agent-sandbox:claude`   | Claude Code                              |

Every image includes mise, Node, pnpm, Git, Git LFS, gh, hc, agent-browser and
Chrome. No host browser or browser profile is mounted. Agent CLIs are separated
by profile; install another CLI in the guest before selecting it there.

`mise run build` builds all four profiles and reuses the common layers. Build a
single profile with `agent-sandbox build --profile codex`. The launcher controls
the sandbox lifetime and initial workload, even with a custom `--image`.

The amd64 OpenCode image requires AVX2 and uses its standard x64 binary. Arm64
Apple silicon images are unaffected. See [OpenCode's installer](https://opencode.ai/v2/install)
for its vendor CPU selection behavior.

## Repository mise configuration

Review the repository's configuration, then run `mise trust`, `mise install`
and its tasks inside the guest. Nothing is trusted or run automatically.
System dependencies can use `[bootstrap.packages]` and
`mise bootstrap packages apply --manager apk`.

The image omits npm, npx, compilers, make and development headers. See
[base-image dependency setup](base-image.md#add-repository-dependencies) for
examples and Wolfi compatibility limits. Guest additions persist across
stop/start; deletion removes them unless they were written to a shared path.
