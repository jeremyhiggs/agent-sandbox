# Changelog

## 0.1.0 (unreleased)

Initial version of `agent-sandbox` for Apple silicon Macs using Apple's container runtime.

- Persistent, named sandboxes with foreground attachment, optional detach,
  independent terminals, shell/exec access, restart, and deletion.
- A Wolfi base with mise, pnpm, Git, GitHub CLI, hc, agent-browser, and Chrome.
  Separate Codex, OpenCode, and Claude Code images share that base.
- Opt-in checkout/worktree, agent login/configuration, and skill mounts.
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

Authentication limitations: Claude's macOS Keychain login is not transferred;
OpenCode host provider-login reuse and refresh remain unverified. State mounts
do not guarantee authentication. Sign in inside the guest. Codex mounts only
`auth.json` read-only into the container process. Guest refresh cannot save
credentials; renew host login and stop/start to reattach the file, or use an
independent guest login. Apple still shares the parent directory with its VM.
