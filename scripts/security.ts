import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVulnerabilities } from "./vulnerabilities.ts";

const root = join(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts");
mkdirSync(artifacts, { recursive: true });
const command = process.argv[2];
if (command === "repo") {
  const report = join(artifacts, "vulnerabilities-repo.json");
  execFileSync(
    "trivy",
    [
      "fs",
      "--ignorefile",
      join(root, ".trivyignore.yaml"),
      "--show-suppressed",
      "--scanners",
      "vuln",
      "--include-dev-deps",
      "--format",
      "json",
      "--output",
      report,
      "--exit-code",
      "0",
      "--skip-dirs",
      ".artifacts",
      "--skip-dirs",
      "node_modules",
      root,
    ],
    { stdio: "inherit" },
  );
  checkVulnerabilities(report);
} else if (command === "browser") {
  const response = await fetch(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
  );
  if (!response.ok)
    throw new Error(`Browser release metadata HTTP ${response.status}`);
  const metadata = (await response.json()) as {
    channels: { Stable: { version: string } };
  };
  const stable = metadata.channels.Stable.version;
  const pinned = process.env.IMAGE_BROWSER_VERSION;
  writeFileSync(
    join(artifacts, "browser-release.json"),
    JSON.stringify({ pinned, stable }, null, 2),
  );
  if (pinned !== stable)
    throw new Error(
      `Browser pin ${pinned} differs from vendor stable ${stable}; update mise.toml and the browser checksums`,
    );
  console.log(`Browser pin matches vendor stable: ${stable}`);
} else throw new Error("Use repo or browser");
