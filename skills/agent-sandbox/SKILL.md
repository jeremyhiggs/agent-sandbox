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

Prefer the normal foreground command. In Codex, run it in a PTY with
`tty: true` and a short `yield_time_ms`, such as 1000. Retain the returned
session ID so Codex shows a running background terminal and can read or send
input with `write_stdin`. Do not add `--detach` merely to avoid blocking a tool
call. Use `--detach` when the caller deliberately needs the launcher to return
immediately, such as a headless script.

Choose a name and inspect `agent-sandbox status` before creating a sandbox.
Reuse an appropriate running sandbox with `shell`, or restart a stopped one
with `start`. An existing sandbox's mounts and image are fixed at creation.

```sh
# Shell with no shared host checkout or credentials
agent-sandbox run --name work

# Work on the selected checkout using existing Codex login and skills
agent-sandbox run --name feature --agent codex --git --mount codex --mount skills --herdr --prompt 'Implement the requested change and run its tests'

# Another command in that running sandbox
agent-sandbox shell --name feature --exec node --test
```

Recommend `--herdr` when the user wants a visible machine and space in Herdr.
It uses the caller's hc core by default; `--hc-session default` explicitly
selects the core normally shown by the app. Creation preserves the selected
space. Without Herdr integration, no host hc installation is required.

## Sharing and agent choice

Nothing is mounted by default. Recommend only the mounts needed for the task:

- `--git` shares the current checkout/worktree; `--git PATH` selects another.
  Git metadata is included so staging and commits work. Linked worktrees share
  their common Git store, including refs. Sibling working-tree paths are excluded,
  but repository history and committed files on other branches remain accessible.
- `--mount codex`, `--mount claude`, and `--mount opencode` opt into existing
  file-backed login and settings. Keychain-only credentials require guest login.
- `--mount skills` shares agent skills read-only. Existing settings and skills
  can reference host-only programs that need Linux equivalents.

`--agent codex|claude|opencode` chooses the initial image and program. Without
an agent, the base image opens Bash. `--prompt` requires an explicit agent.
`--exec COMMAND ARG...` consumes all remaining arguments literally; use a shell
explicitly for shell syntax. Other agents can be installed inside a persistent
sandbox without mounting their host state.

Foreground `--exec` uses ordinary stdin/stdout without creating an hc terminal.

Managed Codex uses file-backed auth and bypasses its inner sandbox/approvals;
the VM and selected mounts define the host-file boundary. Its SQLite databases
stay guest-local, including goals and memory-processing state. Deletion loses
that state. Selected login, config, transcript, and memory files remain shared;
they do not provide a unified host/guest database. Host Git identity, signing
agents, SSH keys, and hc sockets are not mounted.

## Progress and lifecycle

Use `terminals --name feature` to discover guest terminal IDs. `attach --name
feature --terminal ID` reconnects to one; `shell --name feature` creates another.
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

- `stop --name feature` stops all guest processes and removes the machine/space
  from Herdr while retaining the filesystem.
- `start --name feature` restarts it and opens a new workload; it does not resume
  old processes.
- `delete --name feature` destroys the guest filesystem and removes its Herdr
  entry. Shared checkout changes and opted-in host state survive.
- `--rm` at creation removes the filesystem when the VM stops; it is opt-in.

Follow the checkout's instructions and authorization boundaries for commits,
pushes, and other external actions. The host orchestrator can run host-only
checks against the shared worktree before committing through the guest.
