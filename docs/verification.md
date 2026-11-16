# Image verification

Verified locally on Apple silicon with Apple container 1.7.1 on 16 November 2026.
All locally built images below are Linux arm64.

## Image comparison

| Image                                             | Compressed image data | Critical | High | Medium |  Low | Unknown |
| ------------------------------------------------- | --------------------: | -------: | ---: | -----: | ---: | ------: |
| Initial Debian slim with Chromium and build tools |                768 MB |        2 |  515 |    729 | 1095 |      25 |
| Trimmed Debian slim, pnpm, no browser/build tools |                389 MB |        1 |  127 |    173 |  205 |       7 |
| Wolfi core, pnpm, no browser/build tools          |                350 MB |        0 |    0 |      0 |    0 |       0 |
| Wolfi with optional Chrome runtime                |                653 MB |        0 |    0 |      0 |    0 |       0 |

Sizes are rounded decimal MB from the image manifest, not VM disk usage. Counts
combine Trivy's OS and discoverable Node inventories. The initial Debian total
includes two medium Node findings; the later images have none. These are
package/advisory entries, not unique CVEs or individually validated exploit paths.
The two distributions use different advisory feeds and package inventories, so
zero findings alone does not establish that one distribution has no vulnerabilities.

The Debian comparison used a complete, frozen 133-package lock. Its critical
finding was `CVE-2026-60002` in OpenSSH. It shipped the Debian 10.0 package line
and failed the minimum OpenSSH 10.4 policy. Trivy listed no fixed versions for its
128 high/critical entries. These are historical comparison results. Debian build
support and locks have since been removed, and both local Debian sandbox images
were deleted, reclaiming 4.21 GB.

The default Wolfi image has OpenSSH 10.6p2, locked repository packages, and no
libxml2 dependency. The browser profile brings libxml2 2.15.0 through its runtime
libraries; that inventory has no current Trivy findings. Neither profile includes
npm, npx, a generic compiler, make, pkg-config, or the removed development-header
packages. Compiler runtime libraries are retained where other tools require them.

## Built artifacts

| Tag                     | Image index digest                                                        |
| ----------------------- | ------------------------------------------------------------------------- |
| `codex-sandbox:local`   | `sha256:90fb4a5ef879f857a1e8fa4d539ec9c157818ba4b393d75b29305b6244d5f8bd` |
| `codex-sandbox:browser` | `sha256:14f51e4723b62816ac74b2a698b40fce4f5be956255828762e07fbd223e3a61d` |

Shared tool versions: Node 24.22.3, pnpm 11.28.12, mise 2026.11.7, Codex 0.167.2,
agent-browser 0.43.0, hc 0.1.20, and JJ 0.47.1. The browser image uses Google Chrome
for Testing 157.0.8103.78, with separate verified archive hashes for arm64 and amd64.
The pinned Wolfi base index was checked to contain both architectures.

## Passed checks

After removing Debian support, the Wolfi core rebuilt successfully and passed
its runtime inventory/tool checks and Trivy scan with no findings. All 20 tests,
lint/type checks, and four Wolfi lock checks passed. A fresh CodeRabbit review
of the removal returned no findings. The browser rebuild reached its exact
132-package inventory check, then failed on a Chrome download timeout; a retry
failed fetching the APK index. Its tag above remains the earlier image. The
updated image scripts, mounted read-only into that image, passed the inventory,
tool, and agent-browser page/title checks. The temporary builder was removed.

- `mise run check`: formatting, script lint, TypeScript checking, documentation
  lint, TOML formatting, Dockerfile lint, GitHub Actions lint, lock validation,
  and 20 unit tests.
- `mise run audit`: both Node package audits and the Trivy repository scan pass
  without findings. The repository scan includes development dependencies.
  Browser freshness passes too. A deliberately stale pin failed that separate audit.
- Cold builds of both Wolfi profiles and the Debian core comparison passed their
  exact OS inventory checks. The image tools used a frozen pnpm install and
  checksum-verified CLI archives. All eight then-current OS locks passed validation;
  four Wolfi locks remain after removing Debian support.
- `mise run smoke` and `mise run smoke:browser`: linked Git worktree access, skill
  directory/file symlinks, read-only skill enforcement, excluded host-file access,
  shared file/index writes, separate guest hc state, host hc reading a guest
  terminal, persistent mounted files, the default `1.1.1.1` DNS setting, and teardown.
- Image checks assert pnpm and the required tools are usable, removed executables
  are absent, and OpenSSH is at least 10.4. Browser checks open a page, read its
  title through agent-browser, and close the engine.
- The normal host Codex directory mounted in Wolfi, and `codex login status`
  recognized its file-backed ChatGPT login. No inference request was sent and
  credentials were not displayed or copied into the repository/image.
- On-demand installation in a core guest passed agent-browser's automatic Chrome
  discovery and the same page/title test without an executable-path override.
  Wolfi requires `libnss`, not its metadata-only `nss` package, plus `libudev`.
  The installer does not require GTK or a compiler toolchain.
- Earlier installer rejection/recovery checks passed: repeat installation,
  recreation of a missing activation link, bad archive checksum rejection, and
  temporary-file cleanup. Freshness rejection now belongs to `audit:browser`,
  separately from the reproducible browser installer.
- Both final Wolfi images passed their Trivy gates. The trimmed Debian scan failed
  as expected; there are no suppression entries or ignore-unfixed policy.
- Fresh Wolfi guests passed mise repository-config checks: Python 3.13.18 and Go
  1.27.4 installation, config-defined environment variables, a task, and Python SSL
  import. Mise's APK bootstrap installed and ran `file` 5.48 from `mise.toml`.
  The guests used no host mounts and were removed after the checks. See
  [the base image decision](base-image.md) for package catalogue measurements.
- The dependency-locking review covered correctness, testing, maintainability,
  reliability, security, and adversarial cases, with no actionable findings.
  The simplification pass found no worthwhile changes.

Earlier initial-image checks also verified the named Codex terminal task's
`--version` exit/teardown path and a disposable Linux JJ linked workspace layout.
No host repository was initialized with JJ.

## Scan coverage and CI limits

The complete ignored local reports are:

- `.artifacts/vulnerabilities-codex-sandbox-local.json`
- `.artifacts/vulnerabilities-codex-sandbox-browser.json`
- `.artifacts/vulnerabilities-codex-sandbox-debian.json`
- `.artifacts/vulnerabilities.json` (initial baseline)
- `.artifacts/vulnerabilities-repo.json`
- `.artifacts/browser-release.json`

Trivy recognized 68 OS packages in the core image and 132 in the browser image,
plus discoverable Node packages. It did not establish complete CVE coverage for
the separately downloaded Chrome binary. The installer checks the pinned archive
checksum. The independent browser audit checks Google's stable version. The installer records provenance in
`/opt/chrome/vendor-release.json`. Those checks complement the scan; zero reported
findings is not a guarantee of vulnerability-free software.

CI builds and checks both core/browser variants on Linux amd64 and arm64, then
runs the same vulnerability gate and uploads each report. It also runs lint,
tests, repository Trivy and Node dependency audits, and browser freshness. The
schedule is daily at **00:00 UTC** (`0 0 * * *`). Hosted CI has not run: the
repository is local and has no remote. Full image behavior and macOS hc integration
were exercised on arm64. The retired Debian architecture locks came from actual
package installs. Both Wolfi architecture locks came from APK simulation.
Only Wolfi core/browser profiles are supported and included in the CI matrix.

Local testing encountered intermittent Apple guest networking failures, including
with an explicit DNS resolver. Restarting the container services restored access.
The default is now `1.1.1.1`. The `--dns` option and `CONTAINER_DNS` environment
variable select another resolver. No host DNS settings were changed.
Restart services only after checking that no unrelated guests need them.
