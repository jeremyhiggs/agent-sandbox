# Reproducible dependencies

Normal builds consume committed versions, hashes and dependency graphs. Refresh
them deliberately; launching a sandbox does not update them. This guide covers
[lock inputs](#what-is-locked), [refreshing](#refresh-the-locks),
[security policy](#vulnerability-checks) and [rebuild limits](#limits).

## What is locked

| Input                                   | Lock source                                         | Verification                                        |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Wolfi packages and dependencies         | `image/apko.yaml`, `image/apko.lock.json`           | Recipe agreement and exact packages for arm64/amd64 |
| Host tools, including apko and Trivy    | `mise.toml`, `mise.lock`, `.mise/locks/`            | SHA-256 native artifacts and SHA-512 npm graphs     |
| Image mise binary                       | OCI digest in `mise.toml`                           | Specified image content                             |
| pnpm and hc archives                    | `image/artifacts.json`                              | SHA-256 before extraction                           |
| pasta, Podman Compose and python-dotenv | `image/artifacts.json`                              | SHA-256 before extraction                           |
| Agent CLIs and agent-browser            | `image/tools/PROFILE/{package.json,pnpm-lock.yaml}` | Frozen pnpm install with lifecycle scripts disabled |
| Chrome                                  | Version and both architecture hashes in `mise.toml` | Archive SHA-256                                     |
| Repository Node dependencies            | Root `pnpm-lock.yaml`                               | Frozen install                                      |

`mise run lock:check` checks version agreement, architecture locks, archive
metadata and frozen graphs. Apko also rejects a recipe that no longer matches
its lock. The native lock records resolved versions, architectures, URLs and
checksums; package verification uses apko's lock and repository verification.

Host native tools run only after their locked archive hashes are checked. No
mutable remote installer is piped into a shell. npm tools use mise's aube backend
with frozen graphs and integrity checks. CI verifies the mise bootstrap binary's
SHA-256 before execution and installs into a fresh tool directory without caching.

Podman comes from the Wolfi lock. The base image extracts the pasta executable
from the verified Debian archive without installing a Debian package. Podman
Compose and python-dotenv are extracted from verified wheels without running
install hooks. PyYAML comes from the Wolfi lock.

`pnpm-workspace.yaml` applies to the root and all four image profiles. It disables
package lifecycle scripts, rejects exotic transitive sources and trust
downgrades, requires publication metadata and a seven-day release cooldown, and
verifies store integrity. Frozen installs still enforce these rules. Each
profile has its own graph; a root install does not recursively install profiles.

## Dockerfile and Apple container builds

Both engines use the same Dockerfile. The host runs apko for its own architecture
and prepares one locked OS filesystem. Each CI architecture uses a matching
native runner.

Apko writes an OCI layout in a private temporary directory and retains SPDX SBOMs
under `.artifacts/apko/sbom/`. The build script atomically publishes its single
OS layer as a digest-named gzip archive. Concurrent builds use separate work
directories; a four-profile batch reuses one prepared archive.

The Dockerfile starts from `scratch`, adds that archive, copies the mise binary
from its pinned OCI image, then installs pnpm, Chrome and the selected agent.
Apple builds need no Docker daemon or intermediate image registry. Docker builds
use the builder's bundled frontend.

The build context allows only generated OS archives and declared image inputs.
It excludes other `.artifacts/` files, checkout contents, user state and installed
dependencies beneath `image/tools/`. Context and inventory checks are described
in [verification](verification.md). Packages installed later inside a sandbox
are outside the image's exact inventory guarantee.

## Refresh the locks

Run refresh commands only when intentionally changing dependencies. Normal
installation uses `mise install --locked` and frozen project setup.

### Host tools

After changing `[tools]` versions in `mise.toml`, regenerate the lock and npm
sidecars, then review their diff:

```sh
mise lock --upgrade --platform linux-x64,linux-arm64,macos-arm64
mise install --locked
mise run fmt
mise run lock:check
```

Keep `[tool_config] locked = true` scoped to this project.

### OS packages

Edit `image/apko.yaml`, keeping Node and gh versions consistent with `mise.toml`:

```sh
mise run fmt
mise run lock:update
mise run lock:check
```

`lock:update` runs native `apko lock` for both architectures. It does not start a
guest or parse APK terminal output. Ordinary builds reassemble from the recipe
and committed lock without resolving new versions.

### Image tools and Chrome

After changing `IMAGE_*` tool versions in `mise.toml`:

```sh
mise run lock:tools
mise run lock:check
```

`lock:tools` refreshes pnpm and hc archive metadata and the four pnpm graphs,
checking hc archives against the vendor manifest. Update the pasta and Compose
wheel pins in `image/artifacts.json` when refreshing those dependencies. For
Chrome, update its version and both architecture hashes in `mise.toml`, then
run `mise run audit:browser` and the image browser checks.
The audit reports Google's published Linux stable security fixes. A newer release
alone does not require a pin update. Verify archives before extraction or execution.

After any refresh, review the changed pins and run the applicable
[source, audit, image and launcher checks](verification.md#checks). Commit all
related manifests, locks and sidecars together; do not rely on focused lock checks
as the complete pre-push validation.

## Vulnerability checks

`mise run audit` checks the root and image-tool pnpm graphs and the pinned mise
tools against OSV, scans the repository with Trivy and checks Chrome advisories.
`mise run scan` scans all built profiles.
Build first. See [image check commands](verification.md#image-checks) for Docker
and Apple Container variants.

Dependency vulnerabilities at Moderate or Medium and above fail even without a
fix. Image scans also block High and Critical secret findings. The approved
Trivy exception in `.trivyignore.yaml` is:

| Field    | Scope                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| Advisory | [CVE-2026-112366 / GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) |
| Package  | `picomatch@4.0.7`, bundled in pnpm 11.28.12                                                |
| Path     | `opt/pnpm/dist/node_modules/picomatch/package.json`                                        |
| Expiry   | 2026-12-18                                                                                 |

Keep the exception scoped to this bundled package and path. Remove it when a
fixed pnpm distribution is available; do not silently extend it or ignore
all unfixed findings. Complete reports retain suppressed and lower-severity
findings. CI preserves reports and SBOMs; see [report locations](verification.md#reports-and-scan-coverage).

Hashes establish artifact integrity, not complete vulnerability coverage. Trivy
coverage of downloaded native binaries and Chrome is limited. The Chrome audit
checks Google's Linux desktop stable release notes for published security fixes
after the pinned version. Findings at Medium or higher fail the audit. Unpublished
or unrated fixes have no severity match.

## Limits

- Exact package locks do not guarantee byte-identical final OCI images. Later
  installation metadata and timestamps can vary.
- Locks do not retain withdrawn packages. Missing pinned artifacts make builds
  fail rather than silently upgrade. Long-term rebuilds need retained images,
  caches, mirrors or snapshot repositories. See
  [Chainguard's package retention policy](https://www.chainguard.dev/docs/chainguard/containers/building-and-modifying/packages/package-model).
- Reproducible image inputs do not constrain tools installed later by a guest
  repository or make every native binary visible to vulnerability scanners.

See apko's [recipe format](https://github.com/chainguard-dev/apko/blob/main/docs/apko_file.md)
and [native lock schema](https://github.com/chainguard-dev/apko/blob/main/pkg/lock/lock.go).
