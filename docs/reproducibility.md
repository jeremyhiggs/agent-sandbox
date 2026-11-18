# Reproducible dependencies

The OS uses apko's native recipe and lockfile. The Dockerfile adds the browser,
standalone tools, and agent profiles. Refresh tasks change dependency versions
explicitly; security scans use the current advisory database.

## What is locked

| Input                                    | Lock source                                         | Build behavior                                                                      |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Wolfi OS packages and their dependencies | `image/apko.yaml`, `image/apko.lock.json`           | Apko verifies the recipe and installs locked packages for the selected architecture |
| Apko and host build tools                | `mise.toml`, `mise.lock`, `.mise/locks/`            | Locked SHA-256 native artifacts and SHA-512 npm dependency graphs                   |
| Mise image                               | Digest reference in `mise.toml`                     | Copy mise from the specified OCI content                                            |
| pnpm and hc archives                     | `image/artifacts.json`                              | Verify archive SHA-256 before extraction                                            |
| Agent CLIs and agent-browser             | `image/tools/PROFILE/{package.json,pnpm-lock.yaml}` | Frozen pnpm install with lifecycle scripts disabled                                 |
| Chrome                                   | Version and architecture hashes in `mise.toml`      | Verify the pinned archive checksum                                                  |
| Repository Node dependencies             | Root `pnpm-lock.yaml`                               | Frozen installation                                                                 |

`image/apko.yaml` declares the Wolfi repositories, signing key, requested packages,
and arm64/amd64 architectures. The generated native JSON lock records the full
resolved package graph, versions, architectures, URLs, and checksums. It replaces
the former plain-text inventories and custom APK solver-output parser.

`mise run lock:check` checks the locked architectures and version agreement with
mise, standalone archive metadata, and the frozen pnpm graphs. During each image
build, `apko build --lockfile` also rejects a recipe that no longer matches its
lock. It verifies packages using apko's native lock and repository verification.

Host tool installation requires the committed mise lock. Native tools, including
Trivy, are downloaded as archives and checked against the lock's SHA-256 before
execution; no downloaded installer script is run. npm tools use mise's embedded
aube backend with frozen dependency graphs and SHA-512 integrity checks.
CI verifies the mise bootstrap binary's SHA-256 before execution and uses a fresh
tool directory with caching disabled. The image's mise binary comes from a
digest-pinned OCI image. Docker builds use the builder's bundled frontend.

The runtime base starts from `scratch` with apko's locked OS filesystem; it copies
only the mise executable from the OCI source. It does not run the host tool
installation. `image/artifacts.json` therefore locks the pnpm archive needed to
bootstrap package installs and the native hc executable. The profile package
manifests and pnpm locks cover agent-browser and the selected agent separately.

`pnpm-workspace.yaml` defines the installation policy for the root and four image
profiles, each retaining its own lockfile. The same policy is copied into every
image profile before installation. It disables installation scripts, rejects
exotic transitive sources and trust downgrades, requires package publication
metadata and a 24-hour release cooldown, and verifies store integrity. Frozen
installs still enforce the policy; builds do not trust a lockfile to bypass it.
Root installs do not recursively install the agent profiles.

## Dockerfile and Apple container builds

`container build` accepts Dockerfiles. The build script first runs native apko
for the build host's architecture. Apko writes an OCI layout in a private temporary directory and retains SPDX SBOMs
under `.artifacts/apko/sbom/`. The script publishes its single OS layer as a
digest-named gzip tar archive and passes that path to the Dockerfile's standard
`ADD` instruction. Concurrent builds use separate work directories; archive
publication is atomic, and different OS contents get different paths.

The Dockerfile starts from `scratch`, extracts that locked OS filesystem, and
adds mise, pnpm, Chrome, and agent layers. No Docker daemon or intermediate image
registry is needed for Apple builds. Linux CI uses the same Dockerfile with Docker.
Each CI architecture runs on a matching native runner.

The Docker context permits only the generated OS archives and the declared image
sources. It excludes the rest of `.artifacts/`, user state, and checkout contents.
It also excludes installed dependencies beneath `image/tools/`.
`mise run smoke:context` verifies the exported context with Apple's builder;
`smoke:context:ci` runs the same check with Docker in CI.
The final image checks compare its installed APK inventory with the native lock.
Packages installed later by a guest repository are outside this build guarantee.

## Refresh the locks

After changing host tool versions in `mise.toml`, regenerate and commit both the
lock and its npm sidecars:

```sh
mise lock --upgrade --platform linux-x64,linux-arm64,macos-arm64
mise install --locked
mise run lock:check
```

Edit requested OS packages in `image/apko.yaml`. Node and gh version checks still
require agreement with `mise.toml`. Then run:

```sh
mise run fmt
mise run lock:update
mise run lock:check
mise run check
mise run audit
mise run build
mise run check:image
mise run scan
mise run smoke:cli
```

`lock:update` runs `apko lock` for both architectures without starting temporary
VMs or parsing APK terminal output. Normal builds consume the committed lock;
they do not regenerate it or choose newer packages. Apko caches downloads, but
reassembles the OS from the specified recipe and lock once per build invocation.
A four-profile batch shares that prepared filesystem; a standalone profile build
prepares it before building the image.

`lock:tools` refreshes archive URLs/checksums and the four pnpm dependency graphs
for versions selected in `mise.toml`. It checks hc archives against the vendor
manifest. For a Chrome update, change its version and both hashes in `mise.toml`.
`audit:browser` compares the pin with Google's stable release; it does not silently
update an older pinned build.

## Vulnerability checks

```sh
mise run audit
mise run scan
```

The audits cover the root pnpm graph, all four image-tool graphs, repository
Trivy scanning, and Chrome freshness. Image scans cover every built profile.
CI runs on pushes, pull requests, manual requests, and daily at **00:00 UTC**
(`0 0 * * *`). The configured workflow becomes active when commits are pushed
to the GitHub remote. There are no automated dependency update PRs.

HIGH or CRITICAL findings fail, including unfixed findings. Complete Trivy
reports and apko SBOMs remain under `.artifacts/`; CI preserves them as artifacts.
Downloaded native binaries and Chrome have scanner coverage limits.

The temporary exception in `.trivyignore.yaml` accepts CVE-2026-112366 only for
`picomatch@4.0.7` at `opt/pnpm/dist/node_modules/picomatch/package.json`, bundled
in pnpm 11.28.12. The [advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
lists no patched version as of 2026-11-18. This exception expires on 2026-12-18;
remove it when a fixed pnpm distribution is available. Suppressed findings remain
in the JSON reports. Other HIGH/CRITICAL findings still fail.

## Limits

Native apko locks fix package versions and package content verification. This
does not claim that the entire Dockerfile produces byte-identical OCI images:
later installation metadata and build timestamps can vary. The runtime images
continue to verify their exact installed OS inventory.

A lockfile does not retain withdrawn packages. Wolfi repositories can remove old
versions; that makes rebuilding fail rather than silently upgrade. Long-term
rebuilds require a retained image, package cache, mirror, or snapshot repository.
See [Chainguard's package retention policy](https://www.chainguard.dev/docs/chainguard/containers/building-and-modifying/packages/package-model).

See [apko's recipe format](https://github.com/chainguard-dev/apko/blob/main/docs/apko_file.md)
and [native lock schema](https://github.com/chainguard-dev/apko/blob/main/pkg/lock/lock.go).
