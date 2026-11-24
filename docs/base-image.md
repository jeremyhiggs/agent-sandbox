# Base image

Agent sandbox uses Wolfi Linux for all four images. Use mise for language tools
and APK for system libraries, compilers and headers. This guide covers dependency
setup and compatibility limits; see [reproducibility](reproducibility.md) for
image locks and [verification](verification.md) for checks.

## Why Wolfi

Wolfi provides a glibc-based environment for the bundled Linux agent CLIs and
browser. Its packages are assembled with apko and pinned by architecture in
`image/apko.lock.json`. The image checks enforce the package inventory, tool
versions and the OpenSSH minimum version.

Glibc helps with common prebuilt Linux tools, but does not guarantee compatibility
with every binary or library layout. See [Chainguard's libc explanation](https://www.chainguard.dev/docs/chainguard/containers/concepts/glibc-vs-musl).

Wolfi is the only supported base. The distribution determines guest package
compatibility; [mount settings](sharing.md#available-mounts) determine access to
host files. Distribution choice alone does not establish host isolation or
complete vulnerability coverage.

## Add repository dependencies

The shared images omit npm, npx, compilers, make and development headers. Install
what a repository needs inside its sandbox. Review its mise configuration before
trusting it; the image does not automatically trust configs or run their hooks.

For example:

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

Run the language tool setup inside the guest:

```sh
mise trust
mise install
mise run versions
```

New sandboxes run workloads as UID 1000. To install the example APK packages,
run the command below on the Mac as the sandbox owner. Replace `feature` with
the sandbox name.

```sh
container exec --user 0 feature apk add build-base openssl-dev
```

In a root sandbox created with `--no-nested-containers`, you can run
`mise bootstrap packages apply --manager apk` from the trusted repository to
apply its `[bootstrap.packages]`. The APK manager uses the guest's configured
Wolfi repositories, so package names must match Wolfi. Guest packages survive
stop/start and disappear when the sandbox is deleted, except for files written
to a shared host directory.

Mise uses its own [tool backends](https://mise.jdx.dev/dev-tools/backends/).
Precompiled tools often avoid compiler dependencies; source builds and native
extensions still need the relevant libraries and headers. See the
[APK bootstrap manager](https://mise.jdx.dev/bootstrap/packages/apk.html) and
[Python installation options](https://mise.jdx.dev/lang/python.html#how-mise-installs-python).

## Find packages

To refresh the guest catalogue, run `container exec --user 0 feature apk update`
from the Mac. Search it inside the guest before adding dependencies:

```sh
apk search 'go-*'
apk search ninja
apk policy openssl-dev
```

Names can differ from other distributions: Ninja is `ninja-build`, and Chrome
uses `libnss` rather than the metadata-only `nss` package. Common build packages
include `build-base`, `cmake`, `pkgconf`, `openssl-dev` and `zlib-dev`. Check their
available versions and dependencies rather than relying on catalogue counts.
See [Wolfi's package guide](https://www.chainguard.dev/docs/open-source/wolfi#find-wolfi-packages).

## Compatibility limits

- Adapt repositories that assume `apt`, Debian package names or `.deb` files.
  Mise does not translate these commands.
- Some utilities use BusyBox. Install `coreutils` or `findutils` when scripts
  require GNU-specific behavior.
- Check required package names, library layouts and source-build dependencies
  for each repository. Glibc and a large catalogue do not prove compatibility.
- Do not mix Alpine and Wolfi packages, even though both use APK.
- Packages installed by a guest repository are outside the image's exact
  inventory guarantee. Image rebuilds also depend on pinned artifacts remaining
  available; see [rebuild limits](reproducibility.md#limits).

A clean vulnerability scan covers its recognized inventory and advisory feeds.
It does not certify every binary or establish that one distribution is always
safer than another.
