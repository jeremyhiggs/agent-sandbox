# Base image decision

Wolfi is the only supported base for this disposable development environment. Mise supplies
repository tool versions. APK supplies system libraries and optional build tools.
This choice applies to the tested agent environment, not every Linux repository.

## Why Wolfi

This historical comparison used the same browser-free image scope, without npm or build tools.
The current shared base includes Chrome and its runtime libraries; the old sizes
below are not measurements of the current four-profile design.
The local arm64 results from 16 November 2026 are:

| Property                     | Wolfi  | Debian 13 slim                             |
| ---------------------------- | ------ | ------------------------------------------ |
| Compressed image data        | 350 MB | 389 MB                                     |
| Trivy HIGH/CRITICAL findings | 0      | 128                                        |
| OpenSSH client               | 10.6p2 | Debian 10.0 package line                   |
| Required agent tools         | Passed | Tools install, but SSH/security gates fail |

Wolfi supplies an OpenSSH release that passes the minimum version policy. Its
current package inventory also passes the vulnerability gate. These measured
results are the main reasons for the choice. The size difference between the
equivalent lean images is about 10 percent.

Removing the browser and build tools accounts for most savings against the
original 768 MB image. That original image already used Debian slim. A smaller
image alone does not justify a distribution change. Full results and scan limits
are in [image verification](verification.md).

Wolfi uses glibc, unlike musl-based Alpine. This supports common prebuilt Linux
tools without an Alpine-specific build. Our Codex, hc, agent-browser, Chrome,
and mise checks passed. Glibc does not guarantee compatibility with every binary
or its required system libraries. See [Chainguard's libc explanation](https://www.chainguard.dev/docs/chainguard/containers/concepts/glibc-vs-musl).

## Mise support

Mise works in the Wolfi image. It installs tools through its own backends rather
than requiring every tool to exist in APK. Image tool versions are declared in
`mise.toml`. The image build uses a native apko recipe/lock for OS packages, checksum-locked
CLI archives, and frozen pnpm dependencies. The Dockerfile adds the non-APK tools
and agents above apko's OS filesystem. Guest repositories can use [mise backends](https://mise.jdx.dev/dev-tools/backends/) normally.

A fresh guest also passed a repository-config probe with mise 2026.11.7:

- `mise trust` and `mise install` installed Python 3.13.18 and Go 1.27.4.
- `mise run` ran a task with an environment variable from `mise.toml`.
- Python imported `ssl`, and the Go executable reported its version.
- `mise bootstrap packages apply --manager apk` installed `file` through APK.

These checks used no host mounts, credentials, compilers, or development headers.
The guests were removed afterward. They establish common operations, not support
for every mise backend or existing repository config.

Mise can declare system dependencies in the same config as language versions.
For example, a repo that needs a C compiler and OpenSSL headers can use:

```toml
[tools]
python = "3.13"
go = "1"

[bootstrap.packages]
"apk:build-base" = "latest"
"apk:openssl-dev" = "latest"

[tasks.versions]
run = ["python --version", "go version"]
```

Inside the guest, after review of the config:

```sh
mise trust
mise bootstrap packages apply --manager apk
mise install
mise run versions
```

`mise install` alone does not apply the bootstrap package declarations. The APK
manager requires Linux with `apk` on `PATH`. It uses the repositories already
configured in the guest, so its package names must match Wolfi. See
[mise's APK manager](https://mise.jdx.dev/bootstrap/packages/apk.html).

Precompiled tools usually avoid a compiler requirement. A source-build backend,
native extension, or repository task can still require compilers and headers.
For Python, mise downloads a precompiled build by default where one is available.
Other versions or explicit source builds require build dependencies. See
[mise Python installation](https://mise.jdx.dev/lang/python.html#how-mise-installs-python).

## APK catalogue coverage

The aarch64 indexes checked on 16 November 2026 contain **16,118 distinct package
names**, from **5,071 source-package names**. The configured anonymous
[Chainguard index](https://apk.cgr.dev/chainguard/aarch64/APKINDEX.tar.gz) and the
[public Wolfi index](https://packages.wolfi.dev/os/aarch64/APKINDEX.tar.gz) have the
same distinct-name counts at this snapshot.

The count uses unique `P:` fields in `APKINDEX`, not each historical version.
Source-package counts use unique `o:` fields. Counts include version-specific
names and subpackages such as headers, documentation, and runtime libraries.
They are not counts of unrelated applications. An index entry also does not
establish that every version and dependency combination remains installable.

Examples present in those indexes include:

| Need                | Wolfi package examples                                          |
| ------------------- | --------------------------------------------------------------- |
| Native builds       | `build-base`, `gcc`, `clang`, `cmake`, `ninja-build`, `pkgconf` |
| Development headers | `openssl-dev`, `zlib-dev`, `sqlite-dev`, `libffi-dev`           |
| GNU utilities       | `coreutils`, `findutils`                                        |
| Common CLI tools    | `git`, `git-lfs`, `bash`, `curl`, `jq`, `ripgrep`               |
| Runtimes            | `nodejs-24`, `python-3.13`, `go-1.27`                           |
| Clients             | `postgresql-17-client`, `docker-cli`                            |

The catalogue covers common container development needs. It does not need to
contain each JavaScript or Python library, because their package managers supply
those dependencies. Package names still require lookup. For example, Ninja is
`ninja-build`, and Chrome needs `libnss` rather than the metadata-only `nss` package.

In a guest, search before adding dependencies:

```sh
apk update
apk search 'go-*'
apk search ninja
apk policy openssl-dev
```

[Wolfi's package guide](https://www.chainguard.dev/docs/open-source/wolfi#find-wolfi-packages)
also links to a browser-based package explorer. The catalogue and available
versions change, so the counts above are a dated snapshot.

## Compatibility limits

- A repo that assumes `apt`, Debian package names, or `.deb` installation needs
  changes. Mise does not translate those commands or package names.
- Some base utilities are BusyBox variants. Scripts that need GNU-specific flags
  can require `coreutils` or `findutils`.
- Source builds and native extensions need their own system dependencies.
  Removing them from the shared image moves installation to the repo config.
- A required package can be absent or have a different library layout.
  The catalogue size does not prove compatibility with a particular repo.
- Normal builds use exact OS package locks, including transitive dependencies.
  Refresh tasks deliberately resolve new versions. Image checks compare the
  installed package inventory against the lock, but do not cover every repository config.
- Rebuilding requires the pinned archives to remain available. A removed package
  makes the build fail rather than select a newer version. Long-term retention
  requires an archive cache or mirror. See [reproducible dependencies](reproducibility.md).
- Wolfi and Alpine use the APK format, but their packages cannot be mixed.
  An Alpine repository is not a fallback for a missing Wolfi package.
- A clean scan covers the scanner's inventory and advisory feeds. It does not
  certify every binary or prove that Wolfi is universally safer than Debian.

The earlier Debian build path and package locks have been removed. None of the
tested workflows requires them, and maintaining a fallback that fails the security
gate adds no usable capability. A concrete repository compatibility problem can
justify reconsidering that choice. The comparison above records the earlier
measurements; it is not a supported build variant.

The Apple VM and mount policy protect the host filesystem. The distribution
choice controls guest package compatibility, size, and maintenance. It does not
change which host paths Codex can access.
