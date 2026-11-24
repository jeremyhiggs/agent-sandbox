import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBrowser } from "./browser-audit.ts";
import { scanWithTrivy } from "./vulnerabilities.ts";

const root = join(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts");
mkdirSync(artifacts, { recursive: true });
const command = process.argv[2];
if (command === "repo") {
  const report = join(artifacts, "vulnerabilities-repo.json");
  try {
    scanWithTrivy(
      "fs",
      [
        "--include-dev-deps",
        "--skip-dirs",
        ".artifacts",
        "--skip-dirs",
        "node_modules",
        root,
      ],
      report,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
  }
} else if (command === "browser") {
  const report = await auditBrowser(process.env.IMAGE_BROWSER_VERSION ?? "");
  writeFileSync(
    join(artifacts, "browser-release.json"),
    JSON.stringify(report, null, 2),
  );
  if (report.blocking.length) {
    console.error(
      `Chrome ${report.pinned} has published Medium or higher security fixes:`,
    );
    for (const { id, severity, fixedIn, url } of report.blocking)
      console.error(`  ${id} (${severity}), fixed in Linux ${fixedIn}: ${url}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Chrome ${report.pinned}: no published Medium or higher fixes in newer Linux stable releases`,
    );
  }
} else throw new Error("Use repo or browser");
