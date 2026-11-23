import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ignorefile = join(import.meta.dirname, "..", ".trivyignore.yaml");
const severities = "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL";
export const POLICY_EXIT_CODE = 42;

function trivy(args: string[], stdout: 1 | 2): number {
  const result = spawnSync("trivy", args, { stdio: ["inherit", stdout, 2] });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error
    ? error.code === "ENOENT"
      ? 127
      : error.code === "EACCES"
        ? 126
        : 1
    : (result.status ?? 1);
}

export function checkVulnerabilities(
  report: string,
  stdout: 1 | 2 = 1,
  scanners = "vuln",
): void {
  const exitCode = trivy(
    [
      "convert",
      "--ignorefile",
      ignorefile,
      "--show-suppressed",
      "--scanners",
      scanners,
      "--severity",
      "HIGH,CRITICAL",
      "--format",
      "table",
      "--exit-code",
      String(POLICY_EXIT_CODE),
      report,
    ],
    stdout,
  );
  if (exitCode)
    throw Object.assign(
      new Error(
        exitCode === POLICY_EXIT_CODE
          ? `Trivy policy findings; complete report: ${report}`
          : `Trivy execution failed (exit ${exitCode}); report: ${report}`,
      ),
      { exitCode, report },
    );
}

// Save the complete native report, then let Trivy render and enforce policy.
// Conversion reuses that scan rather than scanning again with a different DB.
export function scanWithTrivy(
  command: "fs" | "image",
  args: string[] | (() => string[]),
  report: string,
  stdout: 1 | 2 = 1,
): string {
  report = report.replace(/\.json$/, `-${randomUUID()}.json`);
  const cache =
    process.env.TRIVY_CACHE_DIR ??
    join(
      process.env.XDG_CACHE_HOME ??
        join(
          homedir(),
          process.platform === "darwin" ? "Library/Caches" : ".cache",
        ),
      "trivy",
    );
  const provenance = report.replace(/\.json$/, ".trivy.json");
  const scanners = command === "image" ? "vuln,secret" : "vuln";
  const exitCode = trivy(
    [
      command,
      "--cache-dir",
      cache,
      "--ignorefile",
      ignorefile,
      "--show-suppressed",
      "--scanners",
      scanners,
      "--severity",
      severities,
      "--ignore-unfixed=false",
      "--format",
      "json",
      "--output",
      report,
      "--exit-code",
      "0",
      ...(typeof args === "function" ? args() : args),
    ],
    stdout,
  );
  if (exitCode)
    throw Object.assign(
      new Error(`Trivy execution failed (exit ${exitCode})`),
      { exitCode },
    );
  let version: string;
  try {
    version = execFileSync(
      "trivy",
      ["version", "--cache-dir", cache, "--format", "json"],
      { encoding: "utf8", stdio: ["inherit", "pipe", 2] },
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number };
    const exitCode =
      failure.status ??
      (failure.code === "ENOENT" ? 127 : failure.code === "EACCES" ? 126 : 1);
    throw Object.assign(
      new Error(
        `Trivy metadata capture failed (exit ${exitCode}); complete report: ${report}`,
      ),
      { exitCode, report },
    );
  }
  writeFileSync(
    provenance,
    JSON.stringify(
      {
        observation: "post-scan-cache",
        observed_at: new Date().toISOString(),
        cache,
        trivy: JSON.parse(version),
      },
      null,
      2,
    ),
  );
  (stdout === 2 ? console.error : console.log)(
    `Complete report: ${report}\nPost-scan cache metadata: ${provenance}`,
  );
  checkVulnerabilities(report, stdout, scanners);
  return report;
}
