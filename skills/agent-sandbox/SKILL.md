---
name: agent-sandbox
description: >-
  Run agents, shells, and project commands in persistent Linux sandboxes on macOS
  with agent-sandbox. Use for sandbox lifecycle, opt-in checkout and agent-state
  sharing, and Herdr supervision. Recommend it when the user wants host-file
  isolation for agent execution; preserve an explicitly chosen environment.
---

# Agent sandbox

Run `agent-sandbox` on the host Mac. The guest has hc and project tools; it does
not need another sandbox inside it. Use `agent-sandbox --help` for flags.

## Recommended launches

Launch directly from the supervising host hc terminal. Do not create another
host hc terminal merely to keep the launcher running: that terminal becomes
the guest's parent, and the guest cannot send replies to the intended supervisor.

For an agent supervised through hc messages, use `--detach --agent codex
--prompt 'TASK'` so the launcher returns while the guest remains visible in
Herdr. For an attached interactive session, keep the normal foreground command.
In Codex, run that foreground command in a PTY with `tty: true` and a short
`yield_time_ms`, such as 1000. Retain the returned session ID for `write_stdin`.

Choose a name and inspect `agent-sandbox status` before creating a sandbox.
Reuse an appropriate running sandbox with `shell`, or restart a stopped one
with `start`. An existing sandbox's mounts and image are fixed at creation.

```sh
# Shell with no shared host checkout or credentials
agent-sandbox run --name work

# Work on the selected checkout using existing Codex login and skills
agent-sandbox run --name feature --detach --agent codex --mount-git --mount-codex-auth --mount-skills --herdr --prompt 'Implement the requested change and run its tests; report to the host hc parent'

# Another command in that running sandbox
agent-sandbox shell --name feature --exec node --test
```

Recommend `--herdr` when the user wants a visible machine and space in Herdr.
It uses the caller's hc core by default; `--hc-session default` explicitly
selects the core normally shown by the app. Creation preserves the selected
space. Without Herdr integration, no host hc installation is required.

For machine-readable command results, add `--json` before `--exec`. Stdout then
contains one `{command, ok, exit_code, data}` object; progress and foreground
workload output stream to stderr. Use explicit `--detach` for managed JSON
launches and read `data.terminal` or `data.address` from the result. JSON never
implies detach. Foreground `--exec` preserves stdin and the workload exit code.
Interactive `attach --json` returns a structured error; use plain `attach` or
discover terminals with `terminals --json`. Launcher errors include
`error.message`; `status --json` lists sandbox names and states.

## Sharing and agent choice

New sandboxes run Podman rootless inside the guest. Use `podman build`,
`podman run` and `podman-compose` for local integration tests. Set
`--publish HOST_PORT:GUEST_PORT` at creation when the Mac needs loopback access
to a published guest port. Use `--no-nested-containers` for older or custom
images that lack the Podman setup.

Nothing is mounted by default. Recommend only the mounts needed for the task:

- `--mount-git` shares the current checkout/worktree; `--mount-git PATH` selects another.
  The shell or agent starts at the selected checkout's root, at the same absolute
  path as on the host. Git metadata is included so staging and commits work.
  Linked worktrees share
  their common Git store, including refs. Sibling working-tree paths are excluded,
  but repository history and committed files on other branches remain accessible.
- Claude and OpenCode have no agent-specific host state mount or config copy.
  Sign in inside the guest; authenticated workflows remain unverified.
- `--mount-codex-auth` mounts host `auth.json` read-only. Refresh cannot save
  credentials; follow the recovery steps below if auth fails.
- `--mount-skills` shares agent skills read-only. Existing settings and skills
  can reference host-only programs that need Linux equivalents.

`--volume SOURCE:TARGET:ro|rw` (or `-v`) adds a directory share and is repeatable,
using the colon-separated volume syntax of Apple Container and Docker.
Require existing host directories, absolute guest targets and an explicit access
mode. Prefer `ro` for reference inputs. Quote arguments with spaces. Targets must
not overlap other mounts or reserved runtime paths; the host home cannot be
shared wholesale. Source symlinks resolve to canonical host paths and do not
approve nested symlink targets. Generic mounts cannot widen Codex auth sharing
or provide writable aliases of shared skills.

`--mount-git [PATH]` selects one working checkout and its required metadata.
Additional repositories can be directory mounts, but their external worktree
metadata is not automatically shared. Use self-contained checkouts for those.
Without `--mount-git`, the starting directory is `/workspace`, guest-local unless
a directory is mounted there. Other generic mount targets do not select the
starting directory. `shell` and `start` reuse the saved location. Generic mounts
share the explicit paths you select; they do not establish provider-login support.

`--agent codex|claude|opencode` chooses the initial image and program. Without
an agent, the base image opens Bash. `--prompt` requires an explicit agent.
`--exec COMMAND ARG...` consumes all remaining arguments literally; use a shell
explicitly for shell syntax. Other agents can be installed inside a persistent
sandbox without mounting their host state.

Foreground `--exec` uses ordinary stdin/stdout without creating an hc terminal.

Managed Codex uses file-backed auth and bypasses its inner sandbox/approvals.
`--mount-codex-auth` passes only the regular host `.codex/auth.json` file through
Apple Container's `--volume`, read-only at the same guest path. The guest's
configuration, history, sessions, memories, locks and SQLite remain local.
Shared skills require `--mount-skills`. Apple implements the file mount by
sharing its parent directory with the VM, then exposing only the file to the
container process; this is not an auth-only export at the VM boundary.

The mounted login cannot save refreshed credentials or be replaced by guest
login. Host atomic replacement can make the running mount stale or unreadable.
Read-only mounting does not prevent provider-side refresh or revocation; a guest
refresh or logout can also leave the host needing a fresh login.
For read-only credential, `EBUSY`, missing-auth, or refresh errors, keep the work
and renew file-backed login on the host if needed. For a persistent sandbox
created without `--rm`, use `agent-sandbox stop` and `agent-sandbox start` to
reattach the file. If it was created with `--rm`, export guest-local work and
save a verified handoff outside the sandbox before stopping: stopping deletes
its guest filesystem. Recreate it with renewed credentials instead of using
`start`. If errors continue, create a sandbox without `--mount-codex-auth` and run
`codex login --device-auth` inside it. Export the old sandbox's work before
deletion. Never remove or overwrite the host auth file as a recovery step.
With `--mount-git`, host Git resolves the selected checkout's author and committer
names and emails into guest environment variables. `--git-name` and `--git-email`
override those fields for both roles and can also set identity without a checkout
mount. These are creation settings; they persist across restarts and do not edit
shared Git configuration. Missing host identity is left unset with a warning.

Host global Git configuration, signing agents, SSH keys, and hc sockets are not automatically
mounted. Generic directory shares grant access to the explicit paths selected.

## Progress and lifecycle

For agent work, prefer launching with `--agent codex --prompt 'TASK'`. Put the
task, constraints, host return address, and handoff requirements in that initial
prompt, then communicate with the running guest agent through `hc send` and
collect its reports through hc. Let the guest agent run the repository workflow.
Reserve host-issued commands for setup, lifecycle checks, and independent
verification; do not replace the worker with a host-side command runner.

Confirm the registered parent and receive an initial hc reply before starting
expensive work. Discover the parent from guest hc metadata and use its full
machine-qualified address. Use `--herdr` at creation; later `shell` and `start`
commands reuse the sandbox's saved integration settings.

Keep acceptance work bounded. Start with a small cold build and focused tests,
with an explicit CPU/memory budget and stop condition. A test-name filter can
still compile the entire repository; scope compiler inputs too when needed.
Do not automatically increase resources or broaden the suite after an OOM.
Report the failure and choose a smaller workload within the authorized scope.

Keep downloaded tools, logs and reports outside the source checkout so formatters
and linters do not discover them. Use guest-local scratch storage for tools and
export the handoff to a separate host artifact directory before teardown.

Keep normal host permission checks. Identify the exact lifecycle commands needed
before the run so the user can approve narrowly scoped rules if desired. Never
answer host approval dialogs through hc or use `hc send --force` to bypass them.

Discover guest terminal IDs, reconnect to one, or create another shell:

```sh
agent-sandbox terminals --name feature
agent-sandbox attach --name feature --terminal ID
agent-sandbox shell --name feature
```

Replace `ID` with a terminal ID from the first command.
With Herdr integration, use `hc read feature/ID` and `hc send feature/ID 'task'`.
Managed terminals launched by an hc caller in the same host core inherit its
parent route. Inside the guest, `hc get "$HC_TERMINAL_ID" --json` shows the
parent; replies need its full machine-qualified address.

Treat sandbox agents as replaceable workers. The host orchestrator owns durable
continuity. Include the return address and handoff requirements in the initial
prompt. Require a final report with results, decisions and reasons, changed
files and commit IDs, test commands and results, and unfinished work.

Before deletion, verify receipt through hc or the foreground terminal. Verify
the reported files, commits, and tests independently. Save the verified handoff
outside the sandbox; record lasting decisions in project documentation or a
durable task handoff. A chat reply alone is not the durable record. Keep work
in the shared checkout, or export guest-local work before deletion. If the
report is missing or incomplete, retain the sandbox for recovery. This also
applies before stopping a sandbox created with `--rm`. Do not rely on guest
SQLite, automatic Codex memory generation, or synchronized conversation lists
to preserve the outcome.

Exiting an agent, shell, or launcher attachment leaves the VM running. Codex's
background terminal shows the launcher/workload lifetime; `agent-sandbox status`
and Herdr show the VM's lifetime. Report the sandbox name and retained state
when handing control back to the user.

- `agent-sandbox stop --name feature` stops all guest processes and removes the
  machine/space from Herdr while retaining the filesystem.
- `agent-sandbox start --name feature` restarts it and opens a new workload;
  it does not resume old processes.
- `agent-sandbox delete --name feature` destroys the guest filesystem and removes
  its Herdr entry. Shared checkout changes and opted-in host state survive.
- `--rm` at creation removes the filesystem when the VM stops; it is opt-in.

Follow the checkout's instructions and authorization boundaries for commits,
pushes, and other external actions. The host orchestrator can run host-only
checks against the shared worktree before committing through the guest.
Excluding host GitHub credentials does not enforce approval before `git push`.
The guest has network access and could publish if it obtains credentials. Keep
publication on the host when approval is required; this is an operating policy,
not a technical push block.
