import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePlan } from "../scripts/release-plan.ts";

test("unchanged or decreased versions do not request a release", () => {
  assert.equal(releasePlan("0.2.0", "0.2.0", ""), undefined);
  assert.equal(releasePlan("0.10.0", "0.9.9", ""), undefined);
});

test("a version increase selects exactly its changelog section", () => {
  const changelog = `# Changelog

## 0.2.100

Another release.

## 0.2.10

- Fixed the release job.

### Upgrade

Use the existing installer.

## 0.2.9

Previous notes.
`;
  assert.deepEqual(releasePlan("0.2.9", "0.2.10", changelog), {
    tag: "v0.2.10",
    notes:
      "- Fixed the release job.\n\n### Upgrade\n\nUse the existing installer.",
  });
});

test("a version increase requires a nonempty changelog entry", () => {
  assert.throws(
    () => releasePlan("0.2.0", "0.3.0", "## 0.3.1\n\nOther notes."),
    /Missing changelog entry for 0\.3\.0/,
  );
  assert.throws(
    () => releasePlan("0.2.0", "0.3.0", "## 0.3.0\n\n## 0.2.0\n\nOld notes."),
    /Empty changelog entry for 0\.3\.0/,
  );
});
