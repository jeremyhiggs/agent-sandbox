# Herdr supervision

Use Herdr to see sandbox terminals and exchange tasks and reports with a host
agent. Start here for [connection](#connect-a-sandbox),
[routing](#choose-a-core-space-or-tab) and [handoff](#worker-handoff).

## Connect a sandbox

Install host hc matching `IMAGE_HC_VERSION` in `mise.toml`. The Herdr app must use
the same host core session as the launcher to display its machines. The app need
not be open when you create the sandbox. Without `--herdr`, the guest still has
its own hc and no host hc installation is required.

From the checkout you want to share, run directly in the supervising host hc
terminal:

```sh
agent-sandbox run --name worker --agent codex --detach --json \
  --mount-git --mount-codex-auth --herdr \
  --prompt 'Confirm your hc parent and report readiness to it using hc send before starting work'
agent-sandbox terminals --name worker --json
```

The mounts are optional; Codex auth reuse needs an existing
[file-backed login](sharing.md#codex-read-only-authentication). The launch result
contains `data.terminal` and a qualified `data.address`, such as `worker/t1`.
Use that address, or an ID from terminal discovery, to communicate:

```sh
hc send worker/TERMINAL_ID 'Run the focused tests and report the results'
hc read worker/TERMINAL_ID
hc attach worker/TERMINAL_ID
```

Replace `TERMINAL_ID` with the actual ID. For a non-default core, use the same
`HC_SESSION` for subsequent hc commands. Without host registration, use
`container exec worker hc send TERMINAL_ID 'Run the tests'` instead.

`--herdr` creates a dedicated app space without changing the selected space.
New terminals join that space in separate tabs. Use the wrapper's `stop`, `start`
and `delete` commands: they remove or restore host registration and the sandbox's
app space. Calling Apple's CLI directly bypasses that cleanup.

## Report to the host parent

A managed guest terminal becomes the supervising host terminal's native hc child
when both use the same host core. Launch it directly from that supervisor;
an extra host terminal changes its parent. Launching outside hc or against a
different core creates no host-parent relationship.

Inside the guest, inspect the parent with:

```sh
hc get "$HC_TERMINAL_ID" --json
```

Reply with `hc send <parent> 'Task complete'`, using the full qualified parent
address returned by hc. A bare terminal ID addresses the guest's core instead.
Confirm receipt of the initial readiness message before assigning expensive work.
Guest terminals keep running if their host parent exits.

Transport uses `container exec` through hc's machine connection. It needs no SSH
server, mounted host socket or shared host hc state.

## Choose a core, space or tab

These selectors address different things:

| Option              | Target                              | When to use it                                               |
| ------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `--hc-session NAME` | Host hc core                        | At creation; implies `--herdr` and is saved with the sandbox |
| `--herdr-space ID`  | App space belonging to this sandbox | With `shell`                                                 |
| `--herdr-tab ID`    | Tab in that app space               | With `shell` and `--herdr-space`                             |

```sh
agent-sandbox run --name worker-alt --agent codex --hc-session work
herdr-app ls
agent-sandbox shell --name worker --herdr-space worker/sp123 --herdr-tab worker/tb456
```

Replace the example app IDs with values from `herdr-app ls`. IDs are scoped to
their machine; a guest terminal cannot join a host or another sandbox's space.
Selecting a core does not switch the app's core or selected space. Later `shell`
and `start` calls reuse the saved integration settings; `--herdr` is a creation
option. JSON managed launches still require `--detach`.

## Worker handoff

Keep durable results on the host. Guest transcripts, memories and databases
disappear on deletion, including when a sandbox created with `--rm` stops.
The wrapper does not export or merge them automatically.

Include the return address and report requirements in the initial prompt:
results, decisions and reasons, changed files and commit IDs, test commands and
results, and unfinished work.

Before deleting a sandbox, or stopping one created with `--rm`:

1. Receive the final report. Retain the sandbox if it is incomplete.
2. Verify the reported changes, commits and test results from the host.
3. Save the verified report outside the sandbox and record lasting decisions in
   project documentation or a durable handoff.
4. Confirm the work exists in a shared checkout or an export outside the guest.

Start new worker workflows with a small build and focused tests under an explicit
resource budget. A test-name filter can still trigger a full repository compile.
Keep downloaded tools and reports outside the checkout to avoid lint discovery.
Host permission checks remain enabled; use narrow lifecycle approvals when needed.
