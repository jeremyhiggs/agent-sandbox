# Changelog

## 0.1.0 (unreleased)

Initial version of `agent-sandbox` for Apple silicon Macs using Apple's container runtime.

- Persistent, named sandboxes with foreground attachment, optional detach,
  independent terminals, shell/exec access, restart, and deletion.
- A Wolfi base with mise, pnpm, Git, GitHub CLI, hc, agent-browser, and Chrome.
  Separate Codex, OpenCode, and Claude Code images share that base.
- Dedicated `--mount-git`, `--mount-codex-auth`, and `--mount-skills` helpers,
  plus repeatable directory mounts with explicit guest targets and `ro`/`rw`
  access. Workloads start at the selected checkout root, or `/workspace` by default.
  No host checkout or credentials are mounted by default.
- Optional Herdr spaces and native hc parent reporting without a shared host socket.
- A copied installation that works after the source checkout moves.
  `--skill` prints bundled agent guidance; `--version` reports the CLI version.
- Locked image dependencies, formatting/lint checks, dependency audits, and
  Trivy scans in CI. Scheduled vulnerability checks run at 00:00 UTC.
- A live lifecycle test for subscription login, skills, worktree changes,
  a verified commit, durable host handoff, shell/exec, restart, and cleanup.

Codex SQLite databases stay guest-local. Goals and memory-processing state are
lost on deletion; shared transcript and memory files do not restore every record.
The host orchestrator must verify and save outcomes before teardown.
See [state ownership and handoff](README.md#worker-handoff) for the reason and procedure.

Guest launches require Apple's runtime; Docker is supported for image builds and
scans in CI. The amd64 OpenCode image requires AVX2; arm64 is unaffected.
Opted-in writable mounts expose their contents to the guest agent.

Claude and OpenCode have no agent-specific host state mounts or configuration
copies. Their authenticated workflows remain unverified; sign in inside the
guest. Generic directory shares do not guarantee provider authentication.
Codex mounts only `auth.json` read-only into the container process. Guest refresh
cannot save credentials. Renew host login and stop/start a persistent sandbox
to reattach the file, or use an independent guest login. With `--rm`, export work
and save a verified handoff before stopping, then recreate the sandbox. Apple
still shares the auth file's parent directory with its VM.
