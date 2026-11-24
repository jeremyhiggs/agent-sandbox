#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?}" "${RELEASE_NOTES:?}" "${GITHUB_SHA:?}" "${GITHUB_REPOSITORY:?}"

tag_ref="refs/tags/$RELEASE_TAG"
refs=$(git ls-remote --tags origin "$tag_ref" "${tag_ref}^{}")
tag_commit=$(awk '$2 ~ /\^\{\}$/ { peeled = $1 } $2 !~ /\^\{\}$/ { tag = $1 } END { print peeled ? peeled : tag }' <<<"$refs")
if [[ -z "$tag_commit" ]]; then
  git push origin "$GITHUB_SHA:$tag_ref"
elif [[ "$tag_commit" != "$GITHUB_SHA" ]]; then
  echo "Tag $RELEASE_TAG points to $tag_commit, expected $GITHUB_SHA" >&2
  exit 1
fi

release_state() {
  gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
    --json isDraft,isImmutable --jq '.isImmutable and (.isDraft | not)'
}

if ! immutable=$(release_state); then
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
    --verify-tag --title "$RELEASE_TAG" --notes-file - <<<"$RELEASE_NOTES"
  immutable=$(release_state)
fi
if [[ "$immutable" != true ]]; then
  echo "Expected a published immutable release for $RELEASE_TAG. Check the repository's release settings." >&2
  exit 1
fi
