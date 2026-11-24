import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        SchemaVersion: 2,
        ArtifactName: "fixture",
        ArtifactType: "filesystem",
        Results: [
          {
            Target: "fixture",
            Class: "lang-pkgs",
            Type: "pnpm",
            Vulnerabilities: severities.map((Severity) => ({
              VulnerabilityID: "CVE-2099-0001",
              PkgName: "fixture",
              InstalledVersion: "1.0.0",
              Severity,
            })),
          },
        ],
      }),
    );
    check(path);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("the repository and image gate rejects Medium or higher dependencies without a fix", () => {
  for (const severity of ["MEDIUM", "HIGH", "CRITICAL"])
    report([severity], (path) =>
      assert.throws(
        () => checkVulnerabilities(path),
        (error: unknown) => {
          assert.equal((error as { exitCode: number }).exitCode, 42);
          assert.match((error as Error).message, /policy findings/);
          return true;
        },
      ),
    );
});

test("invalid scanner reports fail as execution errors rather than clean scans", () => {
  report([], (path) => {
    writeFileSync(path, "invalid json");
    assert.throws(
      () => checkVulnerabilities(path),
      (error: unknown) => {
        assert.equal((error as { exitCode: number }).exitCode, 1);
        assert.match((error as Error).message, /execution failed/);
        return true;
      },
    );
  });
});

test("repository and image gate retains lower severity reports without blocking", () => {
  report(["LOW", "UNKNOWN"], (path) =>
    assert.doesNotThrow(() => checkVulnerabilities(path)),
  );
});

test("native gate honors the scoped exception without exempting another package", () => {
  report(["HIGH"], (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const result = data.Results[0];
    result.Target = "opt/pnpm/dist/node_modules/picomatch/package.json";
    Object.assign(result.Vulnerabilities[0], {
      VulnerabilityID: "CVE-2026-112366",
      PkgName: "picomatch",
      InstalledVersion: "4.0.7",
      PkgIdentifier: { PURL: "pkg:npm/picomatch@4.0.7" },
    });
    writeFileSync(path, JSON.stringify(data));
    assert.doesNotThrow(() => checkVulnerabilities(path));
    for (const [target, purl] of [
      ["other/package.json", "pkg:npm/picomatch@4.0.7"],
      [
        "opt/pnpm/dist/node_modules/picomatch/package.json",
        "pkg:npm/other@4.0.7",
      ],
      [
        "opt/pnpm/dist/node_modules/picomatch/package.json",
        "pkg:npm/picomatch@4.0.8",
      ],
    ]) {
      result.Target = target;
      result.Vulnerabilities[0].PkgIdentifier.PURL = purl;
      writeFileSync(path, JSON.stringify(data));
      assert.throws(() => checkVulnerabilities(path), /policy findings/);
    }
  });
});

test("native image gate blocks HIGH secrets as well as package findings", () => {
  report([], (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.Results[0].Secrets = [
      {
        RuleID: "fixture",
        Category: "fixture",
        Severity: "HIGH",
        Title: "Fixture secret",
        StartLine: 1,
        EndLine: 1,
      },
    ];
    writeFileSync(path, JSON.stringify(data));
    assert.throws(
      () => checkVulnerabilities(path, 1, "vuln,secret"),
      /policy findings/,
    );
  });
});

test("a Medium secret alone stays report-only under the dependency policy", () => {
  report([], (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.Results[0].Secrets = [
      {
        RuleID: "fixture",
        Category: "fixture",
        Severity: "MEDIUM",
        Title: "Fixture secret",
        StartLine: 1,
        EndLine: 1,
      },
    ];
    const original = JSON.stringify(data);
    writeFileSync(path, original);
    assert.doesNotThrow(() => checkVulnerabilities(path, 1, "vuln,secret"));
    assert.equal(readFileSync(path, "utf8"), original);
  });
});
