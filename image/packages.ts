import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const packageRequests = {
  wolfi: {
    base: [
      "bash",
      "ca-certificates-bundle",
      "curl",
      "git",
      "git-lfs",
      "jq",
      "less",
      "nodejs-24",
      "openssh-client",
      "procps",
      "ripgrep",
      "tini",
      "unzip",
      "xz",
    ],
    browser: [
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
    ],
  },
  debian: {
    base: [
      "bash",
      "ca-certificates",
      "curl",
      "git",
      "git-lfs",
      "jq",
      "less",
      "libatomic1",
      "libstdc++6",
      "openssh-client",
      "procps",
      "ripgrep",
      "tini",
      "unzip",
      "xz-utils",
    ],
    browser: [
      "fonts-liberation",
      "libasound2t64",
      "libatk-bridge2.0-0t64",
      "libatspi2.0-0t64",
      "libcups2t64",
      "libcairo2",
      "libpango-1.0-0",
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
    ],
  },
};
export type Distro = keyof typeof packageRequests;
export type Profile = "base" | "browser";

export function parsePackagePins(contents: string): string[] {
  const pins = contents.trim().split("\n");
  const names = new Set<string>();
  for (const pin of pins) {
    const name = pin.split("=", 1)[0];
    if (!/^[a-z0-9+_.:-]+=[a-z0-9.+:~_-]+$/i.test(pin) || names.has(name))
      throw new Error("Invalid package lock: " + pin);
    names.add(name);
  }
  return pins;
}

export function parseApkDatabase(database: string): string[] {
  return database
    .trim()
    .split(/\n\n+/)
    .map((record) => {
      const fields = Object.fromEntries(
        record.split("\n").map((line) => [line.slice(0, 1), line.slice(2)]),
      );
      if (!fields.P || !fields.V)
        throw new Error("Invalid APK inventory record");
      return `${fields.P}=${fields.V}`;
    })
    .sort();
}

export function verifyPackageInventory(
  expected: string[],
  actual: string[],
  exact = true,
): void {
  const installed = new Set(actual),
    locked = new Set(expected);
  const missing = expected.filter((pin) => !installed.has(pin));
  const extra = exact ? actual.filter((pin) => !locked.has(pin)) : [];
  if (missing.length || extra.length)
    throw new Error(
      `Package lock mismatch: missing/changed [${missing.join(", ")}]; extra [${extra.join(", ")}]`,
    );
}

export function distro(): Distro {
  return existsSync("/sbin/apk") ? "wolfi" : "debian";
}

export function packagePins(profile: Profile): string[] {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return parsePackagePins(
    readFileSync(
      join(import.meta.dirname, "locks", distro(), arch, `${profile}.txt`),
      "utf8",
    ),
  );
}

export function installedPackages(): string[] {
  return distro() === "wolfi"
    ? parseApkDatabase(readFileSync("/lib/apk/db/installed", "utf8"))
    : execFileSync("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\n"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .sort();
}

export function installBrowserPackages(): void {
  const pins = packagePins("browser");
  if (distro() === "wolfi")
    execFileSync("apk", ["add", "--no-cache", ...pins], { stdio: "inherit" });
  else {
    execFileSync("apt-get", ["update"], { stdio: "inherit" });
    execFileSync(
      "apt-get",
      ["install", "-y", "--no-install-recommends", ...pins],
      { stdio: "inherit" },
    );
    rmSync("/var/lib/apt/lists", { recursive: true, force: true });
  }
  verifyPackageInventory(pins, installedPackages(), false);
}
