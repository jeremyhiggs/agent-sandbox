# File sharing and authentication

Host file access is opt-in. Choose [mounts](#available-mounts), select a
[login method](#authentication-limitations), and use the
[Codex recovery procedure](#codex-read-only-authentication) if shared auth fails.

## Available mounts

| Option                                  | Host content and access                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `--mount-git [PATH]`                    | Read/write checkout or worktree and its required Git metadata, at the same paths |
| `--mount-codex-auth`                    | Read-only `~/.codex/auth.json`, at the same path                                 |
| `--mount-skills`                        | Read-only `~/.agents/skills` and approved direct symlink targets                 |
| `--volume SOURCE:TARGET:ro\|rw` or `-v` | An existing directory at a chosen guest path; repeat for multiple directories    |

These options are independent of agent selection. Without them, no host checkout,
Git metadata, credentials, agent state or skills are mounted. `--home PATH`
selects the state/skills source; it does not share that whole directory.

```sh
agent-sandbox run --name feature --agent codex --mount-git --mount-codex-auth \
  --volume "$HOME/Documents/reference:/reference:ro" \
  --volume "$HOME/Documents/sandbox-output:/output:rw"
```

Each mount is printed before startup with its source, target and access mode.
Mount settings are fixed at creation and reused by `shell` and `start`.

### Directory rules

- Sources must already exist. Relative paths resolve from the caller's working
  directory; source symlinks resolve to their canonical host directory.
- Targets must be absolute guest paths. Specify `ro` or `rw` explicitly and
  quote paths containing spaces. This supports directory bind mounts, not named
  volumes, automatic directory creation or generic file mounts.
- Targets cannot overlap other mounts, the selected checkout or reserved runtime
  paths. Whole host-home and guest-home mounts are rejected.
- With `--mount-codex-auth`, generic shares cannot expose other state from the
  selected host Codex directory or cover its guest directory.
- Writable aliases of shared skills are rejected. Nested symlinks do not approve
  additional host shares.

### Git access and publishing

`--mount-git` selects the checkout root and starting directory. Registered linked
worktrees also share their validated common Git store so status, staging and
commits work. That store includes shared refs and history: the agent can modify
or delete them. Sibling working-tree paths are excluded, but committed files on
other branches remain accessible.

Ordinary checkouts and registered linked worktrees are supported. Symlinked
`.git` paths, separate Git directories and submodule gitfiles are rejected.
Additional `--volume` repositories do not discover external Git metadata; use
self-contained checkouts for those. `.jj` links do not add metadata stores.

Host SSH/AWS directories, credential helpers, signing agents, global Git config,
runtime sockets and host hc state are not forwarded automatically. Configure a
guest Git identity if it needs to commit. `gh` is installed without host GitHub
credentials. Image builds include no user configuration, credentials or checkout
contents.

The guest has network access and can publish if it obtains credentials.
Credential exclusion is not an enforced push-approval gate. Keep publication on
the host when it needs manual approval, and do not provision publishing
credentials in the guest.

## Authentication limitations

Selecting an agent starts its CLI; it does not transfer host authentication or
provider environment variables.

| Agent       | Login method                                                              |
| ----------- | ------------------------------------------------------------------------- |
| Codex       | Opt into the read-only auth-file mount below, or sign in inside the guest |
| Claude Code | Run `claude auth login` in the guest; no host-auth preset or config copy  |
| OpenCode    | Run `opencode auth login` in the guest; no host-auth preset               |

Claude and OpenCode authenticated workflows and refresh remain unverified.
Version checks and fake-state tests do not establish provider or subscription
access. Generic directory sharing is not a supported login-transfer workflow.
Guest-local logins persist across stop/start and are lost on deletion.

## Codex read-only authentication

`--mount-codex-auth` reuses an existing file-backed host login without another
guest sign-in. Both `.codex` and `auth.json` must be real paths, not symlinks;
`auth.json` must be a regular file. Keychain-only credentials are not transferred.
To create file-backed credentials, run on the host:

```sh
codex -c 'cli_auth_credentials_store="file"' login
```

Only `auth.json` reaches the ordinary container process through the read-only
file mount. Host config, hooks, transcripts, sessions and databases are excluded
by that helper; other explicit mounts grant their own access. The guest's remaining
`.codex` state is writable and local.

### Mount and refresh limits

Apple Container 1.7.1 shares the file's parent directory with its VM internally,
then bind-mounts the selected file into the workload. This is not an auth-only
export at the VM boundary. See Apple's [single-file mount trade-offs](https://github.com/apple/containerization/blob/0.54.0/docs/single-file-mounts.md#trade-offs).

The guest cannot save refreshed credentials or replace the mount. Codex uses a
temporary sibling file and atomic rename, which a writable single-file mount
would also reject. Host-side atomic replacement can leave a running mount stale
or unreadable; do not assume a login update reaches a running guest.

Read-only protects the host file, not the provider login grant. Guest refresh or
logout can affect that grant before the local write fails, so the host may also
need a fresh login. An initial successful request does not prove refresh works.

### Recover a login

For read-only-file errors, `EBUSY`, missing `auth.json` or authentication/refresh
failure:

1. Keep the sandbox and its work. Renew the host login with the file-backed
   command above if needed.
2. Check whether the sandbox was created with `--rm` before stopping it.

   For an `--rm` guest, first export local work and save a
   [verified handoff](herdr.md#worker-handoff). Stopping deletes it; recreate the
   sandbox with the renewed auth file instead of using `start`.

   For a persistent guest created without `--rm`, stop and start it to remount
   the current file:

   ```sh
   agent-sandbox stop --name codex-work
   agent-sandbox start --name codex-work --agent codex
   ```

3. If the failure continues, create a sandbox without `--mount-codex-auth` and
   run `codex login --device-auth` inside it for independent, writable credentials.
   Keep or export the old guest's work before deleting it.

## Other agent state

Managed Codex uses `--no-daemon --dangerously-bypass-approvals-and-sandbox`,
file-backed credentials and guest-local SQLite at `/var/lib/agent-sandbox/codex`.
Startup update checks are disabled so the pinned CLI starts without an update
dialog. Claude keeps its normal permission prompts.

Configuration, transcripts, memories, goals and conversation indexes stay in
the guest. Stop/start preserves files but does not resume processes. Deletion,
including stopping an `--rm` sandbox, removes local state unless exported.
Host and guest conversation lists and memory processing are separate; copying
transcripts does not restore every database record.

Concurrent host/guest SQLite coordination through Apple's cross-kernel VirtioFS
mounts is unverified. Keeping databases local avoids relying on shared WAL locks
and memory mappings. Codex's Linux NFS guidance does not establish support for
this transport. See [SQLite WAL requirements](https://www.sqlite.org/wal.html),
[Codex shared-home guidance](https://learn.chatgpt.com/docs/environments/network-file-systems)
and [Apple mount types](https://github.com/apple/container/blob/main/docs/volumes.md).

Custom launches also receive `CODEX_SQLITE_HOME`; an explicit `sqlite_home`
configuration takes precedence. Save outcomes through the
[worker handoff](herdr.md#worker-handoff) before teardown.

### Shared skills

Skills require `--mount-skills`. Codex links into `~/.agents/skills` also need that
mount. Shared files are read-only, and discovery varies by agent. Host-only macOS
tools, MCP servers or paths referenced by a skill need guest equivalents; host
Codex configuration is not loaded.

Direct links in the host skills directory approve additional roots. Their targets
must be direct canonical paths: chained links and symlinked ancestors of skills
directories are rejected. Nested links must stay inside the approved roots and
use paths covered by guest mounts. They never add host shares.
