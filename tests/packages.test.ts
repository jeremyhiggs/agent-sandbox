import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lockedPackages,
  parseApkDatabase,
  verifyPackageInventory,
} from "../image/packages.ts";

test("native apko lock inventories select the requested architecture", () => {
  const lock = {
    contents: {
      packages: [
        { name: "nodejs-24", version: "24.22.3-r2", architecture: "aarch64" },
        { name: "nodejs-24", version: "24.22.3-r3", architecture: "x86_64" },
        { name: "amd-only", version: "1-r0", architecture: "x86_64" },
      ],
    },
  };
  assert.deepEqual(lockedPackages(lock, "arm64"), ["nodejs-24=24.22.3-r2"]);
  assert.deepEqual(lockedPackages(lock, "x64"), [
    "amd-only=1-r0",
    "nodejs-24=24.22.3-r3",
  ]);
  assert.deepEqual(lockedPackages(lock, "amd64"), lockedPackages(lock, "x64"));
  assert.throws(
    () => lockedPackages(lock, "other"),
    /Unsupported architecture/,
  );
  assert.throws(
    () => lockedPackages({ contents: { packages: [] } }, "arm64"),
    /no packages/,
  );
});

test("APK inventory preserves revisions and hyphenated package names", () => {
  assert.deepEqual(
    parseApkDatabase("P:nodejs-24\nV:24.22.3-r2\n\nP:libgcc\nV:16.2.0-r4\n\n"),
    ["libgcc=16.2.0-r4", "nodejs-24=24.22.3-r2"],
  );
});

test("package verification rejects missing, upgraded and extra packages", () => {
  for (const actual of [[], ["curl=2"], ["curl=1", "extra=1"]])
    assert.throws(
      () => verifyPackageInventory(["curl=1"], actual),
      /Package lock mismatch/,
    );
  verifyPackageInventory(["curl=1", "git=2"], ["git=2", "curl=1"]);
});

test("guest browser installation allows repo additions but never locked-package drift", () => {
  verifyPackageInventory(["curl=1"], ["curl=1", "repo-tool=2"], false);
  assert.throws(
    () => verifyPackageInventory(["curl=1"], ["curl=2", "repo-tool=2"], false),
    /Package lock mismatch/,
  );
});
