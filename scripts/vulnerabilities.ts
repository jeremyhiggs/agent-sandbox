import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { failureExitCode, run } from "./process.ts";

const ROOT = join(import.meta.dirname, "..");
const ignorefile = join(ROOT, ".trivyignore.yaml");
const severities = "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL";
export const POLICY_EXIT_CODE = 42;

function trivy(args: string[], stdout: 1 | 2): number {
  const result = spawnSync("trivy", args, { stdio: ["inherit", stdout, 2] });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error ? failureExitCode({ code: error.code }) : (result.status ?? 1);
}

export function checkVulnerabilities(
  report: string,
  stdout: 1 | 2 = 1,
  scanners = "vuln",
): void {
  let temp: string | undefined;
  let exitCode: number;
  try {
    let input = report;
    if (scanners.split(",").includes("secret")) {
      const data = JSON.parse(readFileSync(report, "utf8")) as {
        Results?: { Secrets?: { Severity: string }[] }[];
      };
      // Trivy uses the same severity filter for dependencies and secrets. Its
      // full report retains Medium secrets while the gate keeps their old threshold.
      for (const result of data.Results ?? []) {
        if (!result.Secrets?.some(({ Severity }) => Severity === "MEDIUM"))
          continue;
        result.Secrets = result.Secrets.filter(
          ({ Severity }) => Severity !== "MEDIUM",
        );
        temp ??= mkdtempSync(join(tmpdir(), "agent-sandbox-policy-"));
      }
      if (temp) {
        input = join(temp, "report.json");
        writeFileSync(input, JSON.stringify(data), { mode: 0o600 });
      }
    }
    exitCode = trivy(
      [
        "convert",
        "--ignorefile",
        ignorefile,
        "--show-suppressed",
        "--scanners",
        scanners,
        "--severity",
        "MEDIUM,HIGH,CRITICAL",
        "--format",
        "table",
        "--exit-code",
        String(POLICY_EXIT_CODE),
        input,
      ],
      stdout,
    );
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
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
    const exitCode = failureExitCode({
      status: failure.status,
      code: failure.code,
    });
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

export function scanImage(engine: string, image: string, json = false): string {
  const artifacts = join(ROOT, ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const report = join(
    artifacts,
    `vulnerabilities-${engine}-${image.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
  );
  let temp: string | undefined;
  try {
    return scanWithTrivy(
      "image",
      () => {
        if (engine === "container") {
          // Apple exports an OCI tar; Trivy expects an unpacked OCI layout.
          temp = mkdtempSync(join(tmpdir(), "codex-image-"));
          const archive = join(temp, "image.tar");
          run(engine, ["image", "save", "--output", archive, image]);
          const input = join(temp, "oci");
          mkdirSync(input);
          run("tar", ["-xf", archive, "-C", input]);
          rmSync(archive);
          return ["--input", input];
        } else {
          const identity = run("docker", [
            "image",
            "inspect",
            "--format",
            "{{.Id}} {{.Os}}/{{.Architecture}}",
            image,
          ]).trim();
          const [id, platform] = identity.split(/\s+/);
          if (!id || !platform)
            throw new Error("Docker returned no image identity/platform");
          (json ? console.error : console.log)(
            `Scanning Docker image ${id} (${platform})`,
          );
          temp = mkdtempSync(join(tmpdir(), "codex-image-"));
          const archive = join(temp, "image.tar");
          run("docker", ["image", "save", "--output", archive, id]);
          return ["--input", archive];
        }
      },
      report,
      json ? 2 : 1,
    );
  } finally {
    if (temp) rmSync(temp, { recursive: true });
  }
}
