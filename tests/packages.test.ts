import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApkDatabase,
  parsePackagePins,
  verifyPackageInventory,
} from "../image/packages.ts";

test("package locks require exact versions and reject duplicate names", () => {
  for (const content of [
    "",
    "curl",
    "curl>=1",
    "curl=1\ncurl=2",
    "curl=1\ncurl=1",
  ])
    assert.throws(() => parsePackagePins(content), /Invalid package lock/);
  assert.deepEqual(
    parsePackagePins("libc6:arm64=2.41-12\ncurl=1:8.14.1-2+deb13u2\n"),
    ["libc6:arm64=2.41-12", "curl=1:8.14.1-2+deb13u2"],
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
