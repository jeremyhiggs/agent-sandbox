# Reproducible dependencies

Normal builds use pinned dependency versions. Refresh tasks update the pins
explicitly. Security scans use the current advisory database without updating
the image packages.

## What is locked

| Input                                     | Lock source                                             | Build behavior                                     |
| ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Wolfi, Debian, Node, and mise base images | Digest references in `mise.toml`                        | Pull the specified OCI content                     |
| OS packages and transitive dependencies   | `image/locks/DISTRO/ARCH/PROFILE.txt`                   | Install exact `name=version` entries               |
| pnpm, JJ, and hc archives                 | `image/artifacts.json`                                  | Check the archive SHA-256 before extraction        |
| Codex and agent-browser dependencies      | `image/tools/package.json` and `pnpm-lock.yaml`         | Use pnpm with `--frozen-lockfile --ignore-scripts` |
| Chrome                                    | Version and architecture-specific hashes in `mise.toml` | Check the pinned archive checksum                  |
| Repository Node dependencies              | Root `pnpm-lock.yaml`                                   | Use a frozen install                               |

The OS locks cover Wolfi and Debian, arm64 and amd64, and core/browser profiles.
They include packages inherited from the pinned base, not only explicit requests.
The core has 68 Wolfi packages or 133 Debian packages per architecture.

`mise run lock:check` checks exact pins, duplicate names, package requests, base
digests, and agreement with tool versions in `mise.toml`. Builds run this check
before starting. Image installation and checks compare the actual OS inventory
with the lock. Missing, changed, and additional packages fail the image check.

On-demand browser installation uses the browser lock too. It permits additional
repo packages, but locked packages must match their expected versions. Packages
that a repo installs afterward are outside the base image reproducibility claim.

## Refresh the locks

Version selection for CLI tools and base images remains in `mise.toml`. Direct
OS package requests are in `image/packages.ts`. To refresh dependencies:

```sh
mise run lock:update
mise run lock:tools
mise run lock:check
mise run check
mise run audit
mise run build
mise run scan
mise run smoke
mise run build:browser
mise run scan:browser
mise run smoke:browser
```

`lock:update` resolves complete OS package sets in temporary guests. Wolfi uses
APK's simulation mode. Debian installs the requested packages to capture its
complete dpkg inventory. The guests have no host checkout or credential mounts.
The task removes them afterward. `--distro wolfi|debian`, `--arch arm64|amd64`,
and `--engine container|docker` select a subset or runtime.

`lock:tools` records archive URLs and hashes for the pinned CLI versions and
refreshes the pnpm graph for Codex and agent-browser. It checks the hc archive
against the vendor manifest before recording its hash. `lock:check` validates
the resulting pnpm lock with a frozen install. Dependency changes remain local for review.

For a Chrome update, change its version and both archive hashes in `mise.toml`.
`audit:browser` compares the pin against Google's stable release. This audit is
separate from installation, so a new release does not prevent an old pinned build.

## Vulnerability checks

```sh
mise run audit
mise run scan
mise run scan:browser
```

The local `audit` task includes:

- `audit:node`: pnpm vulnerability audit of the root lockfile.
- `audit:tools`: pnpm vulnerability audit of the image-tool lockfile.
- `audit:repo`: Trivy scan of repository dependencies, including development packages.
- `audit:browser`: vendor stable-version check for the Chrome pin.

CI runs these audits independently and scans both image profiles on amd64 and
arm64. It runs on pushes, pull requests, manual requests, and daily at **00:00 UTC**.
The cron expression is `0 0 * * *`. Hosted runs require a repository remote.
This repository currently has none, so the schedule is configured, not active.

HIGH or CRITICAL findings fail the vulnerability gates. Reports retain lower
severity and unfixed findings. No ignore-unfixed option or vulnerability
suppression file is used. Trivy reports remain in `.artifacts/` locally and as
CI artifacts. Downloaded native binaries still have scanner coverage limits.

## Limits

This provides reproducible dependency versions, not a claim of byte-identical
OCI images. Build timestamps and generated package-manager metadata can differ.
The check proves the installed OS package set, while hashes lock the standalone
archives and pnpm package contents.

Package availability is a separate requirement. Wolfi and Debian repositories
can remove old versions. Exact pins make that a build error instead of an
implicit upgrade. Rebuilds after package removal require a retained image,
archive cache, mirror, or snapshot repository. See
[Chainguard's package retention policy](https://www.chainguard.dev/docs/chainguard/containers/building-and-modifying/packages/package-model).

The mutable package indexes still come from the configured vendor repositories.
Their native package managers check repository signatures and package integrity.
For archive retention independent of those repositories, keep a controlled mirror.
