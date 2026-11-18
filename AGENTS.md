# Agent sandbox verification

This file defines repository verification requirements. Use the `github-account`
skill before PR operations and follow any applicable checkout-local account
guidance.

## Before committing

1. Inspect the branch, working tree, and proposed diff. Preserve unrelated work
   and stage only explicit, task-owned paths.
2. Use the pinned tools: `mise install --locked` and `mise run setup` when the
   install is missing or dependencies changed. Do not refresh locks during normal
   verification.
3. Run `mise run check` against the final changes. It includes formatting, lint,
   TypeScript, unit tests, lock consistency, and the live Chrome freshness audit.
   Browser freshness requires network access; a network failure is not a pass.
   Biome must cover JavaScript/TypeScript and Markdown throughout the repo. Shell
   scripts must pass shfmt and ShellCheck through the same normal validation;
   Biome's unsupported-language warning is not a shell check.
4. Run `git diff --check` and `git diff --cached --check`.
5. Invoke the `privacy-gate` skill and pass `privacy-gate pre-commit` after
   staging. Stop on findings; never bypass hooks with `--no-verify`.

Run focused tests while developing, but do not substitute them for the final
`mise run check`. Fix failures before committing. Do not create new tests that
only assert documentation wording or other mechanical edits.

## Before pushing or updating a PR

Run the CI checks locally before publishing code, configuration, or dependency
changes. Do not assume that a green source check covers audits or images.

```sh
mise run check
mise run audit
mise run smoke:context:ci
mise run build:ci
mise run check:image:ci
mise run scan:ci
```

Use Docker for these CI-equivalent image checks when it is available, including
on macOS. If only Apple container is available, use `smoke:context`, `build`,
`check:image`, and `scan` instead. Check runtime availability before declaring a
check unavailable. Build before checking or scanning; verify all four profiles.
Runtime checks must include an actual Chrome page load and agent separation.

- For launcher, mounts, persistence, terminal, or hc integration changes, also
  run `mise run smoke`. For installer/shim changes, test a disposable installation
  and run the smoke harness against that installed CLI. Preserve the user's
  normal hc session and unrelated containers.
- Run `smoke:herdr` when Herdr integration changes and the app is available.
  `smoke:codex` is an opt-in live test that uses real authentication and model
  requests; do not treat it as a routine pre-push requirement.
- For CI bootstrap or tool-lock changes, verify a fresh locked installation in
  a disposable Linux environment using the CI mise version and bootstrap script.
- For documentation-only changes that do not affect runtime/build behavior,
  configuration, or dependencies, source checks and privacy review suffice;
  explain the image-test omission in the handoff.
- Invoke `coderabbit-local-review` before push/PR updates. Address valid findings
  and rerun affected validation after fixes. Reuse current review and test
  evidence only while the reviewed inputs remain unchanged; rerun live audits
  before publication if their results are stale.
- Inspect existing CI failures and reproduce the failing job's commands locally.
  Confirm the final commit contains the tested changes. State which architecture
  was tested locally; do not claim local amd64 coverage from an arm64 run.
- Ask for approval before pushing, opening/updating a PR, resolving remote review
  state, or rewriting history. Complete local implementation and verification
  first. Run the privacy gate for the publication scope and retain the normal
  pre-push hook. Verify the remote branch/PR head after an approved push.

If a required check cannot run, name the command, blocker, and unverified scope
before requesting publication approval. Do not silently skip it or report a
partial run as passing the full checklist. Retain reports in `.artifacts/`.
Use an isolated Trivy cache when another scan holds the shared cache lock; do not
disable vulnerability scanning to work around contention.

## Downloads, locks, and exceptions

- Every downloaded executable or script must have a pinned version and an
  expected SHA-256 or stronger hash verified before execution. Verify archives
  before extraction. Never pipe a mutable remote installer into a shell.
- Keep native host artifacts in `mise.lock`, npm dependency sidecars in
  `.mise/locks/`, image archives in `image/artifacts.json`, pnpm graphs frozen,
  and OCI base images pinned by digest. Keep downloaded package lifecycle scripts
  disabled. Preserve project-scoped `[tool_config] locked = true`; do not impose
  locked mode on the developer's unrelated global tools.
- When changing Chrome, refresh its version and both architecture hashes, then
  run `audit:browser` and the image browser checks. The freshness audit is separate
  from Trivy's vulnerability coverage.
- HIGH/CRITICAL findings block publication even without a fix, except for
  explicitly approved exceptions. Scope exceptions by advisory, package/version,
  and path, document the reason, set an expiry, and retain suppressed findings in
  reports. Do not enable a blanket `--ignore-unfixed` policy. Remove an exception
  once a fixed distribution is available; do not extend its expiry silently.
- See `docs/reproducibility.md` for lock refresh commands and
  `docs/verification.md` for coverage and limitations. Never equate integrity
  verification with a complete vulnerability audit of native binaries.
