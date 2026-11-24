import assert from "node:assert/strict";
import { test } from "node:test";
import { browserReport, chromeRelease } from "../scripts/browser-audit.ts";

const advisoryURL = "https://example.invalid/desktop-release";

test("a newer Linux release with only Low or ungraded changes passes", () => {
  const low = chromeRelease(
    "Updated to 100.0.1.8 for Linux. <b>Low</b>&nbsp;CVE-2099-1001",
    advisoryURL,
  );
  const later = chromeRelease(
    "Updated to 100.0.1.9 for Linux. A stability improvement.",
    advisoryURL,
  );
  assert.ok(low && later);
  const result = browserReport("100.0.1.7", [later, low]);
  assert.deepEqual(
    result.advisories.map(({ id }) => id),
    ["CVE-2099-1001"],
  );
  assert.deepEqual(result.blocking, []);
});

test("the gate reports published Medium, High, and Critical fixes newer than the pin", () => {
  const release = chromeRelease(
    `Updated to 100.0.1.101 for Mac and Windows and 100.0.1.100 to Linux.
    Medium CVE-2099-1002 <strong>High</strong> CVE-2099-1003
    Critical CVE-2099-1004`,
    advisoryURL,
  );
  assert.ok(release);
  const result = browserReport("100.0.1.99", [release]);
  assert.deepEqual(
    result.blocking.map(({ id, fixedIn }) => [id, fixedIn]),
    [
      ["CVE-2099-1002", "100.0.1.100"],
      ["CVE-2099-1003", "100.0.1.100"],
      ["CVE-2099-1004", "100.0.1.100"],
    ],
  );
});

test("a fix already in the pin is excluded even if a later post repeats the CVE", () => {
  const pinned = chromeRelease(
    "Chrome 100.0.1.8 (Linux) 100.0.1.8/.9 (Windows/Mac). High CVE-2099-1005",
    advisoryURL,
  );
  const newer = chromeRelease(
    "Chrome 100.0.1.10 for Windows, Mac, and Linux. High CVE-2099-1005",
    advisoryURL,
  );
  assert.ok(pinned && newer);
  assert.deepEqual(browserReport("100.0.1.8", [newer, pinned]).blocking, []);
});

test("Desktop updates for Windows and Mac alone do not apply to the Linux guest", () => {
  assert.equal(
    chromeRelease(
      "Updated to 100.0.1.9 for Windows and Mac. Critical CVE-2099-1006",
      advisoryURL,
    ),
    undefined,
  );
});
