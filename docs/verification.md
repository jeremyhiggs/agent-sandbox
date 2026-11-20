# Verification

Use this runbook to select checks and understand their scope. The commands
describe current test coverage, not a record of a fresh passing run. Follow
[AGENTS.md](../AGENTS.md) for the required pre-commit and pre-push checks.

- [Source checks](#checks)
- [Image checks](#image-checks)
- [Launcher checks](#lifecycle-mounts-and-terminals)
- [Optional live tests](#optional-live-tests)
- [Reports and limits](#reports-and-scan-coverage)
- [CI coverage](#ci-coverage)

## Checks

Use the pinned tools and frozen dependencies. If installation is missing or
dependencies changed, run `mise install --locked` and `mise run setup` first.
Normal verification must not refresh locks.

```sh
mise run check
mise run audit
```

`check` covers formatting, lint, TypeScript, unit tests, lock consistency and the
live Chrome stable-version audit. Browser freshness requires network access;
a network failure is not a pass. `audit` checks root and profile pnpm graphs,
repository Trivy findings and browser freshness.

Biome covers JavaScript/TypeScript, Markdown, JSON and YAML. shfmt and ShellCheck
cover shell scripts through the normal `lint` and `check` tasks. Use
`mise run fmt` to apply formatting and `mise tasks` to list tasks.

Documentation-only changes need source checks and privacy review when they do
not affect runtime behavior, build inputs, configuration or dependencies.
Other publication checks remain defined in [AGENTS.md](../AGENTS.md).

## Image checks

Guest launches and launcher smoke tests use Apple Container. Docker is also
supported for image checks and CI. Use Docker when available for the CI-equivalent
pre-push checks; otherwise use the Apple variants.

Run the chosen column in order:

| Step                 | Apple Container          | Docker                      |
| -------------------- | ------------------------ | --------------------------- |
| Verify context       | `mise run smoke:context` | `mise run smoke:context:ci` |
| Build all profiles   | `mise run build`         | `mise run build:ci`         |
| Check runtime        | `mise run check:image`   | `mise run check:image:ci`   |
| Scan vulnerabilities | `mise run scan`          | `mise run scan:ci`          |

Check runtime availability before reporting a command unavailable. Build before
checking or scanning, and cover `base`, `codex`, `opencode` and `claude`.
An arm64 run does not verify amd64; report the architecture actually tested.

### Images and reproducibility

Context checks include declared inputs and exclude private files, retained worker
reports and installed dependencies. Package checks compare the installed APK
inventory with the architecture lock.

Runtime checks cover bundled tool versions, agent separation, supported launch
flags, OpenSSH 10.4 or newer, and absence of npm, npx, compilers, make and
pkg-config. They open a Chrome page through agent-browser, verify its title and
close the browser. See [reproducibility](reproducibility.md) for locks and hashes.

## Lifecycle, mounts, and terminals

Launcher checks need Apple Container running and the images in its image store.
Run `mise run build` if they are missing. Docker image checks use a separate
image store and do not prepare these launcher tests.

For launcher, mounts, persistence, terminal or hc integration changes:

```sh
mise run smoke
```

For installer/shim changes, test a disposable installation and its installed CLI.
The normal installed-launcher check is:

```sh
mise run install
mise run smoke:cli
```

The harness uses a disposable linked worktree, fake credentials and scratch hc
configuration in a separate session. It preserves the normal host core and
unrelated containers. Coverage includes:

- Lifecycle, independent terminals, foreground attach/detach, restart, deletion
  and automatic removal on stop for `--rm` guests.
- Literal arguments, executable paths containing spaces, piped stdin and
  workload exit codes, including nonzero exits.
- Checkout/worktree metadata, starting directories, independent directory mounts,
  read/write modes and mappings retained across stop/start.
- Host-state exclusion by default, read-only skills, auth-file isolation,
  blocked writes/atomic replacement and remounting a host-replaced auth file.
- JSON launch/discovery/restart/deletion and direct exec with output on stderr
  and a preserved exit code.
- hc registration, selected core sessions and cleanup after restart or session
  changes.

Unit tests also check mount aliases and symlinks, invalid Git metadata, JSON
parsing errors and literal `--json` arguments. Invalid interactive JSON requests
must fail before runtime access, and JSON scan failures retain their report path.
Installer tests cover copied-runtime independence, caller CWD, reinstalling,
bundled guidance and refusal to replace unrelated files.

These tests make no model requests. Fake auth and CLI versions do not establish
working provider login, subscription access or token refresh. Apple's internal
auth-parent export and refresh limits remain in effect; see
[authentication boundaries and recovery](sharing.md#codex-read-only-authentication).

## Optional live tests

### Herdr app

With Herdr already open, run `mise run smoke:herdr`. It checks two terminals in a
sandbox's existing app space/tab without changing the selected session, then
removes its own guest and registration. It uses no agent login.

### Codex lifecycle

`mise run smoke:codex` uses real subscription requests and is opt-in, outside
routine pre-push checks and CI. It requires:

- An existing file-backed host ChatGPT login and installed shared agent skills.
- Open Herdr, host Git and hc, and the host `privacy-gate` command.
- Working Apple Container images and enough resources for the assigned task.

The harness mounts the normal `auth.json` read-only and shares skills. It checks
login and state boundaries, assigns a task in a throwaway worktree, verifies its
tests and commit, exercises shell/exec and stop/start, and checks native hc parent
reporting. It uses the default host core and cleans up only its own machine and
orchestrator terminal. Read-only auth can fail when refresh is required; use the
[recovery procedure](sharing.md#codex-read-only-authentication).

Before teardown it verifies the worker's structured report and saves
`handoff.json` outside the guest. The fixture, commit and `report.json` remain in
`.artifacts/codex-lifecycle-*`. If it fails before saving a verified handoff, it
stops and retains the sandbox. Inspect both before manual deletion.
See [worker handoff](herdr.md#worker-handoff) for the durable reporting pattern.

Claude Code and OpenCode authenticated model tasks and refresh remain unverified.
Their version and guest-local state tests do not prove authenticated operation.

## Reports and scan coverage

Keep reports under ignored `.artifacts/`:

- `vulnerabilities-agent-sandbox-{base,codex,opencode,claude}.json`
- `vulnerabilities-repo.json`
- `browser-release.json`
- `apko/sbom/` for native SPDX SBOMs.

HIGH/CRITICAL findings block publication, including unfixed findings, except for
explicit approved exceptions. Reports retain lower severities and suppressed
findings. See the [exception scope and expiry](reproducibility.md#vulnerability-checks).

Trivy covers recognized Wolfi and discoverable Node inventories. Coverage of
downloaded native binaries and Chrome is limited. A verified checksum is not a
complete vulnerability audit; browser provenance and freshness complement scans.
Use an isolated Trivy cache if another scan holds its lock; do not disable scans.

## CI coverage

CI configures source and context checks, separate pnpm/repository/browser audits,
and four-profile Docker builds, runtime checks and Trivy scans on native Linux
amd64 and arm64 runners. It uploads vulnerability reports and OS SBOMs.

Triggers are push, pull request, manual dispatch and daily at **00:00 UTC**
(`0 0 * * *`). Read the job results for a particular commit; configured coverage
does not prove that a run passed. There are no automated dependency-update PRs.
