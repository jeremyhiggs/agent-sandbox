import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedPackages,
  packagePins,
  verifyPackageInventory,
} from "./packages.ts";

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}

const version = process.env.BROWSER_VERSION;
if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version))
  throw new Error("BROWSER_VERSION must be pinned");
const platform = process.arch === "arm64" ? "linux-arm64" : "linux64";
const expected =
  process.env[
    process.arch === "arm64" ? "BROWSER_SHA256_ARM64" : "BROWSER_SHA256_AMD64"
  ];
if (!expected || !/^[a-f0-9]{64}$/.test(expected))
  throw new Error("BROWSER_SHA256 must be pinned for this architecture");
function activate() {
  verifyPackageInventory(packagePins(), installedPackages(), false);
  if (!existsSync("/usr/local/bin/google-chrome"))
    symlinkSync("/opt/chrome/chrome", "/usr/local/bin/google-chrome");
  run("/opt/chrome/chrome", ["--version"]);
}

if (existsSync("/opt/chrome")) {
  const installed = JSON.parse(
    readFileSync("/opt/chrome/vendor-release.json", "utf8"),
  );
  if (
    installed.version !== version ||
    installed.platform !== platform ||
    installed.sha256 !== expected
  )
    throw new Error(
      "Existing browser differs from the pin; start a fresh guest",
    );
  activate();
  process.exit(0);
}

verifyPackageInventory(packagePins(), installedPackages(), false);
const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
const download = await fetch(url);
if (!download.ok) throw new Error(`Browser download: HTTP ${download.status}`);
const temp = mkdtempSync(join(tmpdir(), "browser-install-"));
try {
  const archive = join(temp, "chrome.zip");
  const bytes = Buffer.from(await download.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Chrome archive checksum mismatch");
  writeFileSync(archive, bytes);
  run("unzip", ["-q", archive, "-d", temp]);
  const staged = join(temp, `chrome-${platform}`);
  writeFileSync(
    join(staged, "vendor-release.json"),
    JSON.stringify(
      {
        vendor: "Google Chrome for Testing",
        version,
        platform,
        url,
        sha256: expected,
      },
      null,
      2,
    ),
  );
  renameSync(staged, "/opt/chrome");
} finally {
  rmSync(temp, { recursive: true });
}
activate();
