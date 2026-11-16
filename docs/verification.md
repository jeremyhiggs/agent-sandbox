# Image verification

Verified locally on Apple silicon with Apple container 1.7.1 on 16 November 2026.
All locally built images below are Linux arm64.

## Image comparison

| Image                                             | Compressed image data | Critical | High | Medium |  Low | Unknown |
| ------------------------------------------------- | --------------------: | -------: | ---: | -----: | ---: | ------: |
| Initial Debian slim with Chromium and build tools |                768 MB |        2 |  515 |    729 | 1095 |      25 |
| Trimmed Debian slim, pnpm, no browser/build tools |                402 MB |        1 |  127 |    173 |  205 |       7 |
| Wolfi core, pnpm, no browser/build tools          |                363 MB |        0 |    0 |      0 |    0 |       0 |
| Wolfi with optional Chrome runtime                |                667 MB |        0 |    0 |      0 |    0 |       0 |

Sizes are rounded decimal MB from the image manifest, not VM disk usage. Counts
combine Trivy's OS and discoverable Node inventories. The initial Debian total
includes two medium Node findings; the later images have none. These are
package/advisory entries, not unique CVEs or individually validated exploit paths.
The two distributions use different advisory feeds and package inventories, so
zero findings alone does not establish that one distribution has no vulnerabilities.

The Debian comparison was rebuilt with `apt-get upgrade`. Its remaining critical
finding is `CVE-2026-60002` in OpenSSH. It still ships the Debian 10.0 package line
and fails the minimum OpenSSH 10.4 policy. Trivy listed no fixed versions for its
128 high/critical entries. This comparison is available for Debian-specific repos;
it is not the default image and does not pass the configured security gate.

The default Wolfi image has OpenSSH 10.6p2, current repository packages, and no
libxml2 dependency. The browser profile brings libxml2 2.15.0 through its runtime
libraries; that inventory has no current Trivy findings. Neither profile includes
npm, npx, a generic compiler, make, pkg-config, or the removed development-header
packages. Compiler runtime libraries are retained where other tools require them.

## Built artifacts

| Tag                            | Image index digest                                                        |
| ------------------------------ | ------------------------------------------------------------------------- |
| `codex-sandbox:local`          | `sha256:48edba9cc7b1b8a35e78edd38306a62497dbbacebcdce9e058d8669dd79c69d4` |
| `codex-sandbox:browser`        | `sha256:1c86653b417d2056cb699037143fa50d24e00c2f5c7a7945392a6c039c2aac42` |
| `codex-sandbox:debian`         | `sha256:349957d4c56df23dc72202aafe34cdf7df0ee5137f4dfbb85729c707d048afbc` |
| `codex-sandbox:initial-debian` | `sha256:0f8e85a955178185cb9eb6838087bfad831c2c9460c44b576b6b14ec6ba50da2` |

Shared tool versions: Node 24.22.3, pnpm 11.28.12, mise 2026.11.7, Codex 0.167.2,
agent-browser 0.43.0, hc 0.1.20, and JJ 0.47.1. The browser image uses Google Chrome
for Testing 157.0.8103.78, with separate verified archive hashes for arm64 and amd64.
The pinned Wolfi base index was checked to contain both architectures.

## Passed checks

- `mise run check`: formatting, script lint, TypeScript checking, documentation
  lint, TOML formatting, Dockerfile lint, GitHub Actions lint, and 14 unit tests.
- `mise run audit`: no reported development dependency vulnerabilities. The repo
  was installed with pnpm, then checked with a frozen-lockfile install.
- `mise run smoke` and `mise run smoke:browser`: linked Git worktree access, skill
  directory/file symlinks, read-only skill enforcement, excluded host-file access,
  shared file/index writes, separate guest hc state, host hc reading a guest
  terminal, persistent mounted files, and guest/registration teardown.
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
- Live installer rejection/recovery checks passed: repeat installation, recreation
  of a missing activation link, stale version rejection, rejection of a downloaded
  archive with the wrong checksum, and removal of temporary files after failure.
  The diagnostic guest was then destroyed.
- Both final Wolfi images passed their Trivy gates. The trimmed Debian scan failed
  as expected; there are no suppression entries or ignore-unfixed policy.
- Fresh Wolfi guests passed mise repository-config checks: Python 3.13.18 and Go
  1.27.4 installation, config-defined environment variables, a task, and Python SSL
  import. Mise's APK bootstrap installed and ran `file` 5.48 from `mise.toml`.
  The guests used no host mounts and were removed after the checks. See
  [the base image decision](base-image.md) for package catalogue measurements.
- Code review completed with correctness, testing, maintainability, and reliability
  coverage. Its browser retry finding was fixed and the fix was independently
  rechecked. The simplification pass found no worthwhile changes.

Earlier initial-image checks also verified the named Codex terminal task's
`--version` exit/teardown path and a disposable Linux JJ linked workspace layout.
No host repository was initialized with JJ.

## Scan coverage and CI limits

The complete ignored local reports are:

- `.artifacts/vulnerabilities-codex-sandbox-local.json`
- `.artifacts/vulnerabilities-codex-sandbox-browser.json`
- `.artifacts/vulnerabilities-codex-sandbox-debian.json`
- `.artifacts/vulnerabilities.json` (initial baseline)

Trivy recognized 68 OS packages in the core image and 132 in the browser image,
plus discoverable Node packages. It did not establish complete CVE coverage for
the separately downloaded Chrome binary. The installer checks Google's current
stable version and the pinned archive checksum, and records provenance in
`/opt/chrome/vendor-release.json`. Those checks complement the scan; zero reported
findings is not a guarantee of vulnerability-free software.

CI builds and checks both core/browser variants on Linux amd64 and arm64, then
runs the same vulnerability gate and uploads each report. It also runs lint,
tests, dependency audit, and a weekly refresh. Hosted CI has not run: the
repository is local and has no remote. Only arm64 runtime behavior and macOS hc
integration were exercised locally. Debian is an explicit local comparison,
not part of the passing Wolfi CI matrix.

Local testing encountered intermittent Apple guest networking failures, including
with an explicit DNS resolver. Restarting the container services restored access.
The explicit `--dns` option remains available; no host DNS settings were changed.
Restart services only after checking that no unrelated guests need them.
