# Initial verification

Verified locally on Apple silicon with Apple container 1.7.1 on 16 November 2026.

## Built image

- Tag: `codex-sandbox:local`
- Platform: `linux/arm64`
- Image index: `sha256:0f8e85a955178185cb9eb6838087bfad831c2c9460c44b576b6b14ec6ba50da2`
- Debian 13.7, Node 24.22.3, npm 12.2.2, mise 2026.11.7, Codex 0.167.2,
  agent-browser 0.43.0, hc 0.1.20, JJ 0.47.1.

## Passed checks

- `mise run check`: formatting, script lint, TypeScript checking, documentation
  lint, TOML formatting, Dockerfile lint, GitHub Actions lint, and 14 unit tests.
- `mise run audit`: no reported development dependency vulnerabilities.
- `mise run smoke`: actual Chromium, linked Git worktree access, skill directory
  and file symlinks, read-only skill enforcement, excluded host-file access,
  shared file and index writes, separate guest hc state, host hc reading a guest
  terminal, persistent mounted files, and guest/registration teardown.
- The normal host Codex directory mounted successfully, and `codex login status`
  recognized its file-backed login. Credentials were neither displayed nor copied
  into the repository/image. No inference request was sent.
- The named `codex` task ran `--version` through a guest-core terminal, returned
  exit status zero, and removed its registration and VM.
- A disposable Linux-only JJ repository and linked workspace confirmed the store
  layout used by the mount validation. No host repository was initialized with JJ.
- Structured `autoreview --mode local` completed clean after its accepted findings
  were fixed. Code review: harness-native fallback; the new repository had no
  committed branch base for CE's branch-review workflow. The structured review
  covered the combined staged and unstaged implementation.

The initial runtime checks exposed a DNS problem with the default resolver;
the build succeeded using `mise run build --dns 1.1.1.1`. The README describes
that explicit option. Fixture smoke tests subsequently passed with default DNS
because they do not require public network access.

## Vulnerability scan

`mise run scan` completed against the built image. Its exit status is **1** because
the configured HIGH/CRITICAL gate found:

| Inventory                  | Critical | High | Medium |  Low | Unknown | Fixable high/critical |
| -------------------------- | -------: | ---: | -----: | ---: | ------: | --------------------: |
| Debian packages            |        2 |  515 |    727 | 1095 |      25 |                     0 |
| Discoverable Node packages |        0 |    0 |      2 |    0 |       0 |                     0 |

These are package/advisory entries, so the same advisory may appear against
multiple binary packages. They are scanner findings, not individually validated
exploitable paths. The report listed no Debian fix versions for its high or
critical findings at scan time. Updating npm from the base image's bundled
version to 12.2.2 removed six high-severity Node package findings.

The complete report remains locally at `.artifacts/vulnerabilities.json`. That
generated report is ignored by Git; CI uploads its own complete report as an
artifact. No unfixed findings are suppressed. The image is **not vulnerability
clean**, and the configured image security job will remain red while those
HIGH/CRITICAL findings are present.

## CI coverage and limits

The workflow builds and smoke-checks Linux amd64 and arm64 images using Docker,
and runs the same lint/test and vulnerability gates. It is configured for pushes,
pull requests, manual runs, and weekly advisory refreshes. Hosted CI has not run:
the repository is local and has no remote yet. Only the arm64 Apple build and
the macOS hc integration were executed locally.

The initial version supports a regular Codex directory and direct canonical
skill links. It rejects relocated/chained layouts and external writable
auth/config file links where individual mounts cannot preserve atomic updates.
Those limits are documented in the README and checked before guest creation.
