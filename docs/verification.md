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
live Chrome advisory audit. Chrome fails on published Medium or higher fixes
in a newer Linux stable release. The audit requires network access. `audit`
checks root and profile pnpm graphs, mise tools against OSV, repository Trivy
findings and Chrome advisories.

Biome covers JavaScript/TypeScript, Markdown, JSON and YAML. shfmt and ShellCheck
cover shell scripts through the normal `lint` and `check` tasks. Use
`mise run fmt` to apply formatting and `mise tasks` to list tasks.

Biome rejects unused imports and variables, redundant catch-and-rethrow blocks,
and direct self-comparisons. Test files also fail lint on focused and skipped
test declarations. These checks run through the same `mise run check` in local
development and CI. They do not detect duplicate scenarios, self-comparisons
inside assertion calls, or mocks that manufacture the result under test; review
those cases against the observable behavior and independent expected values.

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

Use `mise run scan:json` for the focused Apple base-image scan through the JSON
CLI path. It runs the same policy gate, keeps native reports, and sends scanner
diagnostics to stderr. It does not replace the four-profile scan above.

### Images and reproducibility

Context checks include declared inputs and exclude private files, retained worker
reports and installed dependencies. Package checks compare the installed APK
inventory with the architecture lock.

Runtime checks cover bundled tool versions, agent separation, supported launch
flags, OpenSSH 10.4 or newer, and absence of npm, npx, compilers, make and
pkg-config. They open a Chrome page through agent-browser, verify its title and
close the browser. See [reproducibility](reproducibility.md) for locks and hashes.

## Lifecycle, mounts, and terminals

After building the base image, `mise run smoke:nested` verifies a rootless
Podman build, a standalone container and a two-service Compose stack in a
disposable Apple guest. It builds from a shared linked worktree and tests inner
read/write and read-only bind mounts alongside synthetic Codex auth and skills
mounts. It also tests HTTP from the guest and macOS loopback, DNS between Compose
services, and that an image can run again after a guest restart.

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

- `vulnerabilities-{container,docker}-agent-sandbox-{base,codex,opencode,claude}-UUID.json`
- `vulnerabilities-repo-UUID.json`
- `vulnerabilities-*.trivy.json` for the scanner version, effective cache and
  database metadata observed after each successful scan, including scans whose
  findings fail policy. This is a post-scan cache observation: another process
  can refresh the shared database between the scan and the metadata read.
- `browser-release.json` for the Chrome pin, the latest Linux stable release
  in the vendor feed, and published severity-rated fixes newer than the pin.
- `apko/sbom/` for native SPDX SBOMs.

Dependency vulnerabilities rated Moderate or Medium and above block publication,
including unfixed findings. High and Critical secret findings also block
publication. Reports retain lower severities and suppressed findings.
See the [exception scope and expiry](reproducibility.md#vulnerability-checks).

Trivy writes the complete JSON report, then `trivy convert` renders a native
table and enforces the severity thresholds using that same scan. Image scans include
vulnerabilities and secrets. Exit 42 means policy findings; execution errors keep
their exit status, including 126/127 for unavailable tools. An error, exclusion or
unrun check is not a clean scan. The CLI's `--json` envelope remains separate from
Trivy's report; scanner output goes to stderr in this mode.

Docker scans inspect the selected daemon, report the actual image ID/platform,
and export that ID through the Docker CLI before scanning the archive. This
preserves the selected context's SSH or TLS transport without registry fallback.
Apple Container scans export its OCI layout because Trivy has no native Apple
image source. Each invocation owns a unique report and sidecar path, so concurrent
scans cannot replace each other's policy input. Docker runtime fixtures use `--pull=never` and `--rm`; automatic
removal includes their anonymous volumes. These runtime checks exercise actual
entry points separately from vulnerability scanning.

Avoid concurrent worktrees building the same local tags. Coordinate image or
cache cleanup with all active build/scan owners, save their reports first, and
inspect exact references on the selected daemon before diagnosing missing images.
Do not use broad image or volume pruning as test teardown. Delete only owned
fixtures and volumes, preserving the original test failure if cleanup also fails.
Historical reports and mocked orchestration tests are not fresh image scans;
retain the scanner, database, platform and image identity when quoting results.

Trivy covers recognized Wolfi and discoverable Node inventories. Coverage of
downloaded native binaries and Chrome is limited. A verified checksum is not a
complete vulnerability audit. `mise run audit:host-tools` queries OSV for the
repository's mise pins and the running mise version. Use mise 2026.11.12 or
newer for this task. Medium and higher findings fail. The report in
`.artifacts/mise-audit.json` retains lower and unrated findings and lists tools
mise could not look up. The Chrome advisory audit checks Google's Linux stable
releases separately.
Use an isolated Trivy cache if another scan holds its lock; do not disable scans.

## CI coverage

CI configures source and context checks, separate pnpm, OSV, Trivy and Chrome audits,
and four-profile Docker builds, runtime checks and Trivy scans on native Linux
amd64 and arm64 runners. It uploads vulnerability reports and OS SBOMs.
Runtime checks and scans require a successful build. A runtime-check failure
still allows scanning that built image, while keeping the job failed.

Triggers are push, pull request, manual dispatch and daily at **00:00 UTC**
(`0 0 * * *`). Read the job results for a particular commit; configured coverage
does not prove that a run passed. There are no automated dependency-update PRs.
