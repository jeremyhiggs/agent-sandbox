import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVulnerabilities } from "../scripts/vulnerabilities.ts";

function report(severities: string[], check: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "audit-report-"));
  try {
    const path = join(directory, "report.json");
    writeFileSync(
      path,
      JSON.stringify({
        Results: [
          {
            Type: "pnpm",
            Vulnerabilities: severities.map((Severity) => ({ Severity })),
          },
        ],
      }),
    );
    check(path);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("repository and image gate rejects either HIGH or CRITICAL with no available fix", () => {
  for (const severity of ["HIGH", "CRITICAL"])
    report([severity], (path) =>
      assert.throws(
        () => checkVulnerabilities(path),
        /1 HIGH\/CRITICAL package findings/,
      ),
    );
});

test("repository and image gate retains lower severity reports without blocking", () => {
  report(["LOW", "MEDIUM", "UNKNOWN"], (path) =>
    assert.doesNotThrow(() => checkVulnerabilities(path)),
  );
});
