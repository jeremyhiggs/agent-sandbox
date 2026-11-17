# Verification

Local verification uses Apple silicon and Apple container 1.7.1. All four
`agent-sandbox` images have passed Linux arm64 builds and runtime checks.
Both architecture locks are validated; actual amd64 builds and runtime checks
remain configured CI coverage.

## Checks

| Area                    | Command                | Verified behavior                                                                                                   |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Source and locks        | `mise run check`       | Formatting, lint, types, unit tests, and dependency-lock consistency                                                |
| Image build             | `mise run build`       | Four Dockerfile targets sharing the locked apko OS and browser base                                                 |
| Image runtime           | `mise run check:image` | Exact APK inventory, tool versions, agent separation, launch flags, and a real browser page load                    |
| Image vulnerabilities   | `mise run scan`        | Trivy scans of all four images; zero findings in the captured reports                                               |
| Repository dependencies | `mise run audit`       | Root and profile pnpm audits, repository Trivy scan, and Chrome stable-version freshness                            |
| Installed launcher      | `mise run smoke:cli`   | Persistent lifecycle, independent terminals, worktrees, opt-in mounts, and isolated host hc supervision             |
| Herdr app               | `mise run smoke:herdr` | Two guest terminals in the same existing app space/tab, with the selected session preserved                         |
| Live Codex              | `mise run smoke:codex` | Real ChatGPT login, shared skills, initial prompt, agent reports, verified commit, shell/exec, restart and deletion |

Run image checks after building the images. The installed-launcher check requires
`mise run install`; the Herdr app check requires Herdr to be open.

The CLI's `--skill` prints the bundled recommendations without a separate skill
installation. A process test reads it from outside a checkout with an empty
`PATH`, so discovery needs no container runtime or host hc. Foreground launching
was also checked in a Codex background PTY: the launcher stayed running and
accepted shell input while its sandbox appeared in Herdr.

The installer test copies the runtime twice, moves the source directory, then
runs the installed command from another directory. It checks bundled guidance,
caller-directory preservation, image locks, reinstalling, and refusal to replace
unrelated commands or directories. A fixture mise shim avoids changing host
trust during unit tests; a local install also verifies the real mise launcher.

## Images and reproducibility

The supported tags are `agent-sandbox:base`, `agent-sandbox:codex`,
`agent-sandbox:opencode`, and `agent-sandbox:claude`. Each agent image adds only
its selected agent CLI to the shared browser-equipped base.

The native apko lock contains 131 arm64 packages and 132 amd64 packages. Checks
compare the installed APK inventory with that lock. Tool installation uses
checksum-pinned archives and frozen pnpm graphs, with vendor lifecycle scripts
disabled. Versions and artifact pins are defined in `mise.toml` and the files
listed in [reproducibility](reproducibility.md).

The OS build checks also verified:

- A changed recipe without a regenerated lock fails apko's checksum validation.
- Repeated and parallel builds produce identical, verified OS layer archives.
- Private build directories and atomic publication prevent overlapping builds
  from reading partial output.
- A batch prepares its OS once and reuses it for all four images.

Image runtime checks exercise mise, Node, pnpm, Git, gh, JJ, hc,
agent-browser, and the selected agent. They check native agent launch flags,
OpenSSH 10.4 or newer, and absence of npm, npx, generic compilers, make, and
pkg-config. A Chrome page is opened through agent-browser, its title is read,
and the browser is closed.

## Lifecycle, mounts, and terminals

The installed CLI smoke test uses fake agent state, a separate linked Git
worktree, and scratch hc configuration in a separate core session. It verifies:

- Explicit commands and names, literal arguments, piped input, and workload exit
  codes, including a nonzero exit.
- Guest-local `/workspace` by default, with no host checkout or worktree shared.
- Current-worktree file/index writes with `--git`, and explicit checkout
  selection with `--git PATH`.
- Visible Git metadata and staging in selected normal checkouts and linked
  worktrees, including their required external Git stores.
- Multiple independent guest terminals; exiting one leaves the others and the
  sandbox running.
- Foreground attachment, detach without ending the guest terminal, and
  reattachment by terminal name.
- Guest-local files surviving stop/start, explicit deletion, and automatic
  removal on sandbox stop when created with `--rm`.
- Exclusion of host agent state and skills by default, plus individual and
  combined opt-in mounts.
- Writable Codex, Claude, and OpenCode state directories, read-only shared
  skills, and a guest-local Claude config copy without host writeback.
- Host-file exclusion and rejection of symlinks that would widen mount access.
- Independent guest hc state, selected host-core registration, restoration after
  restart, and cleanup after the caller changes its hc session.

Unit checks also reject invalid Git selections before runtime discovery and
worktree pointers redirected to an unrelated common Git store.

The app smoke test creates its own sandbox in the normal host core. It verifies
creation of a dedicated sandbox space and joining that sandbox's existing space
and tab without changing the selected session. It removes its test sandbox and
registration afterward.

Herdr app IDs are qualified by machine. Guest labels can join only spaces
belonging to that sandbox. Host hc core-session selection is a separate option.

The CLI and Herdr app smoke tests exercise file sharing and process/session management with
fake authentication state. They make no model requests and do not establish
provider login or subscription acceptance.

The separate, opt-in `smoke:codex` test uses the normal host Codex login and
shared skills for a real model task. It checks the guest's ChatGPT login status,
matching skill bytes and read-only access, and exclusion of an unshared host
file. It verifies that Codex created its runtime database in guest-local storage.
It independently tests Codex's changes, runs the host privacy gate, commits
through the guest, and asks Codex to verify and report the SHA. It verifies the
exact committed tree and unchanged main branch.
It exercises another shell, direct exec, retained guest files across stop/start,
hc registration cleanup, and deletion. It uses the default host hc core and
verifies that the sandbox appears in the Herdr app. It removes only its own
machine and orchestrator terminal and never stops the host core. It verifies
removal from Herdr on stop and deletion, and reappearance after restart.
It also verifies
the guest's native host-parent relationship and direct progress and commit
reports over hc's existing connection, without a mounted host socket. Its retained
`.artifacts/codex-lifecycle-*/report.json` records the outcome. This test is not
part of CI.

The worker sends a structured final handoff with results, decisions and reasons,
changed files, the commit ID, tests and results, and unfinished work. The host
collector uses raw terminal input and first checks a report larger than 4 KiB
to detect terminal input truncation. The host
verifies the handoff against the tested worktree and saves `handoff.json` before
teardown. The test checks that the handoff and shared commit survive deletion.
It does not depend on the guest SQLite database for continuity. If the test fails
before it records a verified handoff, it stops and retains the sandbox for recovery.
Inspect the retained fixture and sandbox before manual deletion.

Codex emitted hook warnings inside Linux during the live run. Its model task,
skill access, and Git commit still completed; the host privacy gate ran
separately before the commit.

## Reports and scan coverage

The ignored local reports are:

- `.artifacts/vulnerabilities-agent-sandbox-base.json`
- `.artifacts/vulnerabilities-agent-sandbox-codex.json`
- `.artifacts/vulnerabilities-agent-sandbox-opencode.json`
- `.artifacts/vulnerabilities-agent-sandbox-claude.json`
- `.artifacts/vulnerabilities-repo.json`
- `.artifacts/browser-release.json`

Native apko SPDX SBOMs are retained under `.artifacts/apko/sbom/`.

The captured image and dependency reports contain zero findings. HIGH or
CRITICAL findings fail the gates even when no fixed version is available;
complete reports retain the lower severities too.

Trivy covers the recognized Wolfi and discoverable Node inventories. Its coverage
of downloaded native binaries and Chrome is limited. Archive checksums, browser
release provenance, and the separate Chrome freshness check complement the scan.

## CI coverage

CI configures Docker image builds, runtime checks, and Trivy scans for Linux
amd64 and arm64. It also runs source checks, pnpm audits, repository Trivy, and
browser freshness checks. Image reports, repository reports, and native OS SBOMs
are uploaded as artifacts.

The schedule is daily at **00:00 UTC** (`0 0 * * *`), with push, pull request,
and manual triggers. Hosted CI has not run yet; local arm64 verification is the
executed evidence described above.
