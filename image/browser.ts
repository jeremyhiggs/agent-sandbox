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
const response = await fetch(
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
);
if (!response.ok)
  throw new Error(`Browser release metadata: HTTP ${response.status}`);
const metadata = (await response.json()) as {
  channels: { Stable: { version: string } };
};
if (metadata.channels.Stable.version !== version)
  throw new Error(
    `Browser pin ${version} is behind vendor stable ${metadata.channels.Stable.version}; update mise.toml`,
  );

function activate() {
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

if (existsSync("/sbin/apk")) {
  run("apk", [
    "add",
    "--no-cache",
    "alsa-lib",
    "at-spi2-core",
    "cairo",
    "cups-libs",
    "font-liberation",
    "glib",
    "libatk-1.0",
    "libatk-bridge-2.0",
    "libdrm",
    "libx11",
    "libxcb",
    "libxcomposite",
    "libxdamage",
    "libxext",
    "libxfixes",
    "libxkbcommon",
    "libxrandr",
    "mesa-gbm",
    "libnspr",
    "libnss",
    "libudev",
    "pango",
  ]);
} else {
  run("apt-get", ["update"]);
  run("apt-get", [
    "install",
    "-y",
    "--no-install-recommends",
    "fonts-liberation",
    "libasound2t64",
    "libatk-bridge2.0-0t64",
    "libatspi2.0-0t64",
    "libcups2t64",
    "libdrm2",
    "libgbm1",
    "libnss3",
    "libudev1",
    "libx11-xcb1",
    "libxcomposite1",
    "libxdamage1",
    "libxfixes3",
    "libxkbcommon0",
    "libxrandr2",
  ]);
  rmSync("/var/lib/apt/lists", { recursive: true });
}
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
