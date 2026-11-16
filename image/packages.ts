import { readFileSync } from "node:fs";
import { join } from "node:path";

export const packageRequests = [
  "bash",
  "ca-certificates-bundle",
  "curl",
  "git",
  "gh",
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
];

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

export function packagePins(): string[] {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return parsePackagePins(
    readFileSync(
      join(import.meta.dirname, "locks", "wolfi", arch, "base.txt"),
      "utf8",
    ),
  );
}

export function installedPackages(): string[] {
  return parseApkDatabase(readFileSync("/lib/apk/db/installed", "utf8"));
}
